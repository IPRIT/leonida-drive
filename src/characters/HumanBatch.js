// Instanced renderer for humanoid figures with three LODs:
//   near (< ~25 m): articulated full-detail parts (one draw call per part type), shadows;
//   mid (~25..70 m): boxy limbs, 8-sided head, no hands or face details (shadow / no-shadow sets);
//   far: one-mesh impostor with vertex-shader walk cycle, no shadows.
// Instances are compacted every frame: only figures written this frame are drawn, so hidden or distant
// figures cost nothing. Clothing, skin, patterns and tattoos come from per-instance attributes (looks.js).
import * as THREE from 'three';
import { PARTS, MESH_MULT } from './rig.js';
import { STRIDE } from './looks.js';
import {
  prismGeometry, headGeometry, handGeometry, footGeometry,
  headExtrasGeometry, wearGeometry, chestExtrasGeometry, hipExtrasGeometry, handExtrasGeometry, farGeometry,
  prism4Geometry, head8Geometry, hairMidGeometry, hatMidGeometry, chestMidGeometry, hipMidGeometry, handMidGeometry,
  HAIR_BITS, HAIR2_BITS, FACE_BITS, HAT_S_BITS, HAT_W_BITS, EYE_BITS, EAR_BITS, MID_HEAD_BITS, MID_HAT_BITS, MID_CHEST_BITS, MID_HIP_BITS, MID_HAND_BITS,
} from './geometry.js';

let GEOS = null;
function geometries() {
  if (GEOS) return GEOS;
  const hx = headExtrasGeometry(), wy = wearGeometry();
  GEOS = {
    prism: prismGeometry(), head: headGeometry(), hand: handGeometry(), foot: footGeometry(),
    hair: hx.hair, hair2: hx.hair2, face: hx.face, hatS: wy.hatS, hatW: wy.hatW, eyes: wy.eyes, ears: wy.ears,
    chestX: chestExtrasGeometry(), hipX: hipExtrasGeometry(), handX: handExtrasGeometry(),
    prism4: prism4Geometry(), head8: head8Geometry(), hairM: hairMidGeometry(), hatM: hatMidGeometry(), chestM: chestMidGeometry(),
    hipM: hipMidGeometry(), handXM: handMidGeometry(),
    far: farGeometry(),
  };
  return GEOS;
}

// LOD sets: [geometry, look source (rig mesh key), style bits needed (0 = always drawn)]
const ALL = 0x7fffffff;
const SETS = {
  near: [['prism', 'prism', 0], ['head', 'head', 0], ['hand', 'hand', 0], ['foot', 'foot', 0],
    ['hair', 'headX', HAIR_BITS], ['hair2', 'headX', HAIR2_BITS], ['face', 'headX', FACE_BITS], ['hatS', 'headY', HAT_S_BITS], ['hatW', 'headY', HAT_W_BITS],
    ['eyes', 'headY', EYE_BITS], ['ears', 'headY', EAR_BITS],
    ['chestX', 'chestX', ALL], ['hipX', 'hipX', ALL], ['handX', 'handX', ALL]],
  mid: [['prism4', ['prism', 'foot'], 0], ['head8', 'head', 0],
    ['hairM', 'headX', MID_HEAD_BITS], ['hatM', 'headY', MID_HAT_BITS], ['chestM', 'chestX', MID_CHEST_BITS], ['hipM', 'hipX', MID_HIP_BITS], ['handXM', 'handX', MID_HAND_BITS]],
};
const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

const VERT_DECL = /* glsl */`
attribute vec3 iColA; attribute vec3 iColB; attribute vec3 iColC; attribute vec4 iCloth; attribute vec2 iShape;
attribute float aT; attribute float aStyle; attribute float aChan;
varying vec3 vColA; varying vec3 vColB; varying vec3 vColC; varying vec4 vCloth; varying vec3 vLoc; varying float vT; varying float vChan;
`;
const VERT_SHAPE = /* glsl */`
vec3 transformed = vec3( position );
transformed.xz *= mix( 1.0, iShape.x, aT );
if ( aStyle > -0.5 ) {
  // piece shown only if the figure's style mask shares a bit with the piece's mask
  if ( ( int( iShape.y + 0.5 ) & int( aStyle + 0.5 ) ) == 0 ) transformed = vec3( 0.0 );
}
`;
const VERT_BEGIN = VERT_SHAPE + /* glsl */`
vLoc = position; vT = aT; vChan = aChan; vColA = iColA; vColB = iColB; vColC = iColC; vCloth = iCloth;
`;

const FRAG_DECL = /* glsl */`
varying vec3 vColA; varying vec3 vColB; varying vec3 vColC; varying vec4 vCloth; varying vec3 vLoc; varying float vT; varying float vChan;
float hHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float hNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hHash( i ), hHash( i + vec2( 1, 0 ) ), f.x ), mix( hHash( i + vec2( 0, 1 ) ), hHash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float gSpark = 0.0; // sequin / gem glitter of this fragment (emissive)
vec3 hRib( vec3 a, vec3 p ) { return a * ( 0.62 + 0.12 * step( 0.5, fract( atan( p.z, p.x ) * 5.0 ) ) ); }
vec3 hCloth( vec3 a, vec3 c, vec3 b, float pat, vec3 p, float t ) {
  float ang = atan( p.z, p.x );
  vec2 uv = vec2( ang * 0.95, p.y * 2.6 );
  float front = step( p.z, -0.5 );
  if ( pat > 99.5 ) { // ribbed hem band at the bottom of the part (jackets)
    pat -= 100.0;
    if ( t > 0.86 ) return pat > 22.5 && pat < 23.5 ? mix( hRib( a, p ), c, step( 0.5, fract( t * 22.0 ) ) * 0.8 ) : hRib( a, p );
  }
  vec3 c2 = c;
  if ( pat > 39.5 ) { // worn open over the top: centre front strip shows colour C, prints use colour B
    pat -= 40.0;
    if ( front > 0.5 && abs( p.x ) < 0.24 ) return c;
    c2 = b;
  }
  if ( pat < 0.5 ) return a;
  if ( pat < 1.5 ) { // hawaiian: flowers + leaves
    vec2 q = uv * 2.4; vec2 cell = floor( q ); vec2 f = fract( q ) - 0.5;
    vec2 o = ( vec2( hHash( cell + 3.1 ), hHash( cell + 7.7 ) ) - 0.5 ) * 0.35;
    vec2 dd = f - o; float d = length( dd );
    float petal = 0.2 + 0.09 * cos( atan( dd.y, dd.x ) * 5.0 + hHash( cell ) * 6.0 );
    float fl = step( d, petal ) * step( 0.3, hHash( cell + 1.3 ) );
    float leaf = step( 0.62, hNoise( q * 1.6 + 11.0 ) ) * ( 1.0 - fl );
    vec3 col = mix( a, a * 0.55 + vec3( 0.0, 0.12, 0.04 ), leaf * 0.75 );
    col = mix( col, c2, fl );
    return mix( col, vec3( 1.0, 0.85, 0.3 ), fl * step( d, 0.06 ) );
  }
  if ( pat < 2.5 ) return mix( a, c2, step( 0.5, fract( t * 4.0 ) ) );
  if ( pat < 3.5 ) { // worn / faded
    float n = hNoise( uv * 5.0 ) * 0.6 + hNoise( uv * 13.0 ) * 0.4;
    vec3 col = a * ( 0.78 + 0.3 * n );
    return mix( col, a * 0.6 + 0.12, step( 0.83, hNoise( uv * 3.0 + 4.0 ) ) );
  }
  if ( pat < 4.5 ) { // plaid
    float b1 = step( 0.6, fract( uv.x * 2.5 ) ), b2 = step( 0.6, fract( uv.y * 2.5 ) );
    vec3 col = mix( a, c2, 0.55 * max( b1, b2 ) );
    return mix( col, a * 0.5, 0.35 * b1 * b2 );
  }
  if ( pat < 5.5 || ( pat > 29.5 && pat < 30.5 ) ) { // suit (30: pinstripes): jacket over shirt + tie on the front
    vec3 base = pat > 29.5 ? mix( a, a * 0.5 + 0.42, step( 0.93, fract( uv.x * 9.0 ) ) ) : a;
    float vee = step( abs( p.x ), 0.18 + 0.32 * ( 1.0 + p.y ) );
    float shirt = front * vee * step( -0.85, p.y );
    float tie = front * step( abs( p.x ), 0.075 + 0.04 * ( 1.0 + p.y ) ) * step( -0.98, p.y );
    vec3 col = mix( base, vec3( 0.93 ), shirt );
    return mix( col, c, tie );
  }
  if ( pat < 6.5 ) return a * ( 0.86 + 0.22 * hNoise( vec2( uv.x * 28.0, uv.y * 7.0 ) ) ); // denim
  if ( pat < 7.5 ) return mix( a, c, step( t, 0.1 ) ); // collar / cuff trim
  if ( pat < 8.5 ) { // hoodie: pocket + drawstrings on the front
    float pocket = front * step( abs( p.x ), 0.55 ) * step( 0.45, t ) * step( t, 0.95 );
    float strings = front * step( abs( abs( p.x ) - 0.16 ), 0.03 ) * step( t, 0.4 );
    return mix( mix( a, a * 0.82, pocket ), vec3( 0.95 ), strings );
  }
  if ( pat < 9.5 ) return mix( a, c, step( 0.86, abs( p.x ) ) ); // sport side stripes
  if ( pat < 10.5 ) { vec2 q = uv * 4.0; vec2 f = fract( q ) - 0.5; return mix( a, c2, step( length( f ), 0.18 ) ); } // dots
  if ( pat < 11.5 ) { // graphic tee: original sunset-and-palm emblem on the front
    vec2 q = vec2( p.x, p.y + 0.45 ) * vec2( 1.0, 1.6 );
    float r = length( q );
    float em = front * step( r, 0.36 );
    vec3 sun = mix( c, vec3( 1.0, 0.85, 0.35 ), step( 0.0, q.y ) );
    float bands = step( 0.5, fract( q.y * 9.0 ) ) * step( q.y, 0.0 );
    float palm = step( abs( q.x - 0.12 + q.y * 0.25 ), 0.03 ) * step( -0.36, q.y );
    vec3 col = mix( sun, a * 0.35, max( bands * 0.6, palm ) );
    return mix( a, mix( col, a * 0.4, step( 0.33, r ) ), em );
  }
  if ( pat < 12.5 ) { // tie-dye swirl
    float s = sin( ang * 3.0 + p.y * 9.0 + hNoise( uv * 2.0 ) * 4.0 );
    return mix( a, c2, smoothstep( -0.3, 0.3, s ) );
  }
  if ( pat < 13.5 ) return mix( a, c, step( 0.76, t ) ); // shoe sole
  if ( pat < 14.5 ) { // flamingo print: pink birds on one leg
    vec2 q = uv * vec2( 2.0, 1.6 ); vec2 cell = floor( q ); vec2 f = fract( q ) - 0.5;
    f.x += ( hHash( cell + 2.0 ) - 0.5 ) * 0.3;
    float flip = hHash( cell + 9.0 ) > 0.5 ? 1.0 : -1.0; f.x *= flip;
    float body = step( length( ( f - vec2( 0.02, 0.0 ) ) * vec2( 1.0, 1.7 ) ), 0.16 );
    float neck = step( abs( f.x + 0.12 - 0.05 * sin( ( f.y - 0.05 ) * 14.0 ) ), 0.025 ) * step( 0.0, f.y ) * step( f.y, 0.3 );
    float head = step( length( f - vec2( -0.1, 0.32 ) ), 0.05 );
    float beak = step( length( f - vec2( -0.15, 0.3 ) ), 0.025 );
    float leg = step( abs( f.x - 0.02 ), 0.012 ) * step( -0.42, f.y ) * step( f.y, -0.08 );
    float bird = max( max( body, neck ), max( head, leg ) );
    vec3 col = mix( a, c2, bird );
    col = mix( col, vec3( 0.1 ), beak );
    return mix( col, a * 0.7 + 0.1, step( 0.72, hNoise( q * 3.0 ) ) * ( 1.0 - bird ) * 0.4 );
  }
  if ( pat < 15.5 ) { // palm leaves: big fronds with a vein
    vec2 q = uv * 1.6; vec2 cell = floor( q ); vec2 f = fract( q ) - 0.5;
    float an = hHash( cell ) * 6.28; vec2 r = vec2( cos( an ) * f.x + sin( an ) * f.y, -sin( an ) * f.x + cos( an ) * f.y );
    float leaf = step( length( r * vec2( 1.0, 2.6 ) ), 0.42 );
    float teeth = step( 0.5, fract( r.x * 14.0 ) ) * step( 0.06, abs( r.y ) );
    float vein = step( abs( r.y ), 0.012 );
    vec3 col = mix( a, c2, leaf * ( 1.0 - teeth * 0.35 ) );
    return mix( col, a, vein * leaf );
  }
  if ( pat < 16.5 ) { // camo
    float n1 = hNoise( uv * 1.7 + 3.0 ), n2 = hNoise( uv * 2.9 + 11.0 ), n3 = hNoise( uv * 4.1 + 23.0 );
    vec3 col = mix( a, c2, step( 0.55, n1 ) );
    col = mix( col, a * 0.45, step( 0.62, n2 ) );
    return mix( col, mix( a, c2, 0.5 ) * 1.25, step( 0.7, n3 ) );
  }
  if ( pat < 17.5 ) { // gingham checks
    float b1 = step( 0.5, fract( uv.x * 3.0 ) ), b2 = step( 0.5, fract( uv.y * 3.0 ) );
    return mix( a, c2, 0.45 * ( b1 + b2 ) );
  }
  if ( pat < 18.5 ) { // leather biker: open front, zip, seams, a soft sheen down the sides
    if ( front > 0.5 && abs( p.x ) < 0.22 ) return c;
    float zip = front * step( abs( p.x - 0.25 ), 0.025 );
    float sheen = smoothstep( 0.35, 0.75, abs( p.x ) ) * ( 1.0 - smoothstep( 0.75, 1.0, abs( p.x ) ) );
    vec3 col = a * ( 0.8 + 0.55 * sheen ) + vec3( 0.04 ) * sheen;
    col = mix( col, a * 0.5, step( abs( t - 0.55 ), 0.02 ) );
    return mix( col, vec3( 0.62, 0.64, 0.68 ), zip );
  }
  if ( pat < 19.5 ) { // bomber: open zip front, quilted look
    if ( front > 0.5 && abs( p.x ) < 0.18 ) return c;
    return a * ( 0.9 + 0.12 * step( 0.5, fract( t * 5.0 ) ) );
  }
  if ( pat < 20.5 ) { // blazer: lapel V shows the top, two buttons
    float vee = front * step( abs( p.x ), 0.08 + 0.42 * ( 1.0 + p.y ) * step( -0.62, p.y ) );
    float btn = front * step( length( vec2( p.x - 0.1, t - 0.35 ) ), 0.04 );
    return mix( mix( a, c, vee ), a * 0.4, btn );
  }
  if ( pat < 21.5 ) { // denim jacket: open front, pocket flaps, seams
    if ( front > 0.5 && abs( p.x ) < 0.2 ) return c;
    vec3 col = a * ( 0.86 + 0.22 * hNoise( vec2( uv.x * 28.0, uv.y * 7.0 ) ) );
    float flap = front * step( abs( abs( p.x ) - 0.5 ), 0.17 ) * step( abs( t - 0.32 ), 0.07 );
    float seam = step( abs( t - 0.18 ), 0.012 ) + front * step( abs( abs( p.x ) - 0.5 ), 0.01 ) * step( t, 0.5 );
    return mix( mix( col, a * 0.7, flap ), vec3( 0.85, 0.65, 0.35 ), min( 1.0, seam ) * 0.7 );
  }
  if ( pat < 22.5 ) { // track jacket: centre zip, side stripes
    float zip = front * step( abs( p.x ), 0.02 );
    return mix( mix( a, c, step( 0.84, abs( p.x ) ) ), vec3( 0.75 ), zip );
  }
  if ( pat < 23.5 ) { // varsity: snaps down the front
    float snap = front * step( length( vec2( p.x, fract( t * 4.0 ) - 0.5 ) ), 0.06 );
    return mix( a, c, snap );
  }
  if ( pat < 24.5 ) { // windbreaker: colour-block chest band, zip
    float band = step( abs( t - 0.45 ), 0.16 );
    return mix( mix( a, c, band ), vec3( 0.2 ), front * step( abs( p.x ), 0.02 ) );
  }
  if ( pat < 25.5 ) { // cargo: thigh pockets with flaps
    float side = step( 0.62, abs( p.x ) ) * step( abs( p.z ), 0.75 );
    float pocket = side * step( 0.4, t ) * step( t, 0.78 );
    float flap = pocket * step( t, 0.47 );
    return mix( a, a * 0.7, pocket * 0.5 + flap * 0.5 );
  }
  if ( pat < 26.5 ) return mix( a, c, step( 0.62, t ) ); // boots over the trousers
  if ( pat < 27.5 ) { // sequins
    vec2 q = uv * vec2( 14.0, 9.0 ); vec2 cell = floor( q );
    float h = hHash( cell );
    gSpark = step( 0.78, h ) * step( length( fract( q ) - 0.5 ), 0.35 );
    return a * ( 0.75 + 0.45 * h ) + gSpark * 0.35;
  }
  if ( pat < 28.5 ) { // retro sunset stripes
    float k = fract( t * 1.5 );
    return mix( mix( a, c2, smoothstep( 0.0, 1.0, k ) ), vec3( 1.0, 0.9, 0.6 ), step( 0.9, k ) * 0.6 );
  }
  if ( pat < 29.5 ) { // leopard spots
    vec2 q = uv * 3.2; vec2 cell = floor( q ); vec2 f = fract( q ) - 0.5;
    vec2 o = ( vec2( hHash( cell + 1.0 ), hHash( cell + 5.0 ) ) - 0.5 ) * 0.4;
    float r = length( ( f - o ) * vec2( 1.0, 1.3 ) ) * ( 1.0 + 0.3 * hNoise( q * 4.0 ) );
    vec3 col = mix( a, c2 * 0.6, step( r, 0.22 ) * step( 0.13, r ) );
    return mix( col, a * 1.1 + 0.05, step( r, 0.13 ) * 0.5 );
  }
  return hRib( a, p ) * step( 0.86, t ) + a * step( t, 0.86 ); // 31: ribbed cuff
}
// angle difference wrapped to -π..π (a design centred at seed shows wherever seed lies on the limb)
float hWrap( float a ) { return mod( a + 3.14159265, 6.2831853 ) - 3.14159265; }
vec3 hSkin( vec3 s, float tat, vec3 p, float t ) {
  if ( tat < 0.5 ) return s;
  float st = floor( tat ), seed = fract( tat ) * 10.0;
  float ang = atan( p.z, p.x );
  vec2 uv = vec2( ang, p.y * 4.0 );
  float ink = 0.0;
  vec3 inkCol = vec3( 0.05, 0.08, 0.1 );
  if ( st < 1.5 ) { // tribal band
    float y0 = mix( -0.75, -0.3, fract( seed * 1.37 ) );
    float w = 0.05 + 0.04 * abs( sin( ang * 3.0 + seed ) );
    ink = step( abs( p.y - y0 + 0.05 * sin( ang * 4.0 + seed ) ), w );
    ink = max( ink, step( abs( p.y - y0 - 0.13 ), 0.02 ) );
  } else if ( st < 2.5 ) { // full sleeve
    ink = step( 0.52, hNoise( uv * vec2( 2.2, 1.6 ) + seed ) ) * step( p.y, -0.04 ) * step( -0.96, p.y );
    ink = max( ink, step( 0.8, hNoise( uv * 7.0 + seed ) ) * step( p.y, -0.05 ) );
  } else if ( st < 3.5 ) { // star
    vec2 q = vec2( hWrap( ang - seed ) * 0.9, ( p.y + 0.5 ) * 3.0 );
    float a = atan( q.y, q.x ), r = length( q );
    ink = step( r, 0.22 + 0.12 * cos( a * 5.0 ) );
  } else if ( st < 4.5 ) { // script lines
    float line = step( 0.82, fract( p.y * 6.0 + seed ) );
    ink = line * step( 0.42, hNoise( vec2( ang * 9.0, p.y * 6.0 ) + seed ) ) * step( abs( hWrap( ang - seed + 5.0 ) ), 1.6 );
  } else if ( st > 5.5 ) {
    vec2 q = vec2( hWrap( ang - seed ) * 0.9, ( p.y + 0.5 ) * 3.0 );
    float r = length( q ), a = atan( q.y, q.x );
    if ( st < 6.5 ) { // waves: rolling lines around the limb
      float w = sin( ang * 4.0 + seed * 3.0 + p.y * 2.0 ) * 0.06;
      ink = step( abs( fract( ( p.y + w ) * 7.0 ) - 0.5 ), 0.08 ) * step( p.y, -0.08 ) * step( -0.92, p.y );
    } else if ( st < 7.5 ) { // palm tree: trunk + fronds
      float trunk = step( abs( q.x + q.y * 0.15 ), 0.035 ) * step( -0.9, q.y ) * step( q.y, 0.3 );
      float fr = step( abs( sin( a * 3.0 ) ), 0.35 ) * step( length( q - vec2( 0.05, 0.38 ) ), 0.38 ) * step( 0.06, length( q - vec2( 0.05, 0.38 ) ) );
      ink = max( trunk, fr );
    } else if ( st < 8.5 ) { // sun: disc + rays
      ink = max( step( r, 0.16 ), step( abs( r - 0.27 ), 0.06 ) * step( 0.5, fract( a * 2.0 ) ) );
    } else if ( st < 9.5 ) { // geometric band of triangles
      float k = fract( ang * 1.9 + seed );
      ink = step( abs( p.y + 0.5 ), 0.16 ) * step( abs( k - 0.5 ) * 0.32, 0.16 - abs( p.y + 0.5 ) ) + step( abs( abs( p.y + 0.5 ) - 0.19 ), 0.012 );
    } else if ( st < 10.5 ) { // heart + banner
      vec2 h = q - vec2( 0.0, 0.08 ); h.y -= sqrt( abs( h.x ) ) * 0.25;
      float heart = step( length( h ), 0.2 );
      float banner = step( abs( q.y + 0.14 ), 0.05 ) * step( abs( q.x ), 0.32 );
      vec3 col = mix( s, vec3( 0.7, 0.08, 0.12 ), heart * 0.85 );
      return mix( col, inkCol, banner * 0.8 + step( abs( length( h ) - 0.2 ), 0.02 ) * 0.8 );
    } else if ( st < 11.5 ) { // snake coiling round the limb
      float body = step( abs( p.y + 0.5 - 0.22 * sin( ang * 2.0 + seed ) ), 0.05 );
      float head = step( length( vec2( hWrap( ang - seed ) * 0.5, p.y + 0.15 ) ), 0.08 );
      ink = max( body * step( p.y, -0.15 ), head );
    } else { // back pieces (12 wings, 13 sunburst): only on the back of the torso
      float back = step( 0.15, p.z );
      vec2 b = vec2( p.x, p.y + 0.45 );
      if ( st < 12.5 ) {
        float fan = step( 0.4, fract( atan( b.y + 0.4, abs( b.x ) ) * 4.0 ) ) * step( length( b ), 0.75 ) * step( 0.12, abs( b.x ) );
        ink = fan * back;
      } else {
        float rr = length( b ), aa = atan( b.y, b.x );
        ink = back * max( step( rr, 0.18 ), step( 0.24, rr ) * step( rr, 0.7 ) * step( 0.55, fract( aa * 3.0 ) ) );
      }
    }
  } else { // rose: red petals, green leaves
    vec2 q = vec2( hWrap( ang - seed ) * 0.9, ( p.y + 0.45 ) * 3.0 );
    float r = length( q );
    float petals = step( r, 0.28 ) * step( 0.5, fract( r * 9.0 + atan( q.y, q.x ) * 0.6 ) );
    float leaf = step( abs( q.x - 0.32 ), 0.1 ) * step( abs( q.y + 0.2 ), 0.08 );
    vec3 col = mix( s, vec3( 0.65, 0.06, 0.1 ), petals * 0.85 );
    col = mix( col, vec3( 0.1, 0.35, 0.12 ), leaf * 0.8 );
    return mix( col, inkCol, step( abs( r - 0.3 ), 0.025 ) * 0.8 );
  }
  return mix( s, inkCol, ink * 0.78 );
}
vec3 humanAlbedo() {
  float ch = floor( vChan + 0.5 );
  if ( ch < 0.5 ) {
    bool cov = vT >= vCloth.x && vT <= vCloth.y;
    return cov ? hCloth( vColA, vColC, vColB, vCloth.z, vLoc, vT ) : hSkin( vColB, vCloth.w, vLoc, vT );
  }
  if ( ch < 1.5 ) return vColA;
  if ( ch < 2.5 ) return vColB;
  if ( ch < 3.5 ) return vColC;
  if ( ch < 4.5 ) return vec3( 0.025 );
  if ( ch < 5.5 ) return vec3( 0.9 );
  if ( ch < 6.5 ) return vColA * 0.6;
  if ( ch < 7.5 ) return vec3( 0.85, 0.62, 0.18 );
  if ( ch < 8.5 ) return vec3( 0.45, 0.7, 0.95 );
  if ( ch < 9.5 ) return vColC * 0.55;
  if ( ch < 10.5 ) return vColB * vec3( 0.8, 0.52, 0.5 );
  if ( ch < 11.5 ) return vColB * 0.55;
  if ( ch < 12.5 ) return vec3( 0.55, 0.57, 0.6 );
  if ( ch < 13.5 ) return vColC * ( 0.3 + 0.55 * smoothstep( -0.05, 0.3, vLoc.y ) ) + vec3( 0.05 ); // lens: tinted gradient
  gSpark = 0.6 + 0.4 * step( 0.5, fract( ( vLoc.x + vLoc.y * 1.7 + vLoc.z * 2.3 ) * 9.0 ) ); // gem
  return vec3( 0.92, 0.95, 1.0 );
}
`;

function humanMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.0, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', VERT_BEGIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( humanAlbedo(), opacity );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif ( abs( vChan - 8.0 ) < 0.5 ) totalEmissiveRadiance += vec3( 0.3, 0.5, 0.7 );\ntotalEmissiveRadiance += diffuseColor.rgb * gSpark * 0.55;');
  };
  m.customProgramCacheKey = () => 'leonida-human-2';
  return m;
}

function humanDepthMaterial() {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 iShape; attribute float aT; attribute float aStyle;')
      .replace('#include <begin_vertex>', VERT_SHAPE);
  };
  m.customProgramCacheKey = () => 'leonida-human-depth-1';
  return m;
}

const FAR_DECL = /* glsl */`
attribute vec3 iColA; attribute vec3 iColB; attribute vec3 iColC; attribute vec3 iHair; attribute vec2 iAnim;
attribute float aLimb; attribute float aChan;
varying vec3 vFarCol;
`;
const FAR_BEGIN = /* glsl */`
vec3 transformed = vec3( position );
if ( aLimb > 0.5 ) {
  float leg = step( aLimb, 2.5 );
  float ph = iAnim.x + ( ( aLimb > 1.5 && aLimb < 3.5 ) ? 3.14159 : 0.0 );
  float a = sin( ph ) * iAnim.y * mix( 0.7, 1.0, leg );
  float py = mix( 0.8, 0.53, leg );
  vec3 q = transformed - vec3( 0.0, py, 0.0 );
  float c = cos( a ), s = sin( a );
  transformed = vec3( q.x, q.y * c - q.z * s, q.y * s + q.z * c ) + vec3( 0.0, py, 0.0 );
}
vFarCol = aChan < 1.5 ? iColA : aChan < 2.5 ? iColB : aChan < 3.5 ? iColC : iHair;
`;

function farMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${FAR_DECL}`).replace('#include <begin_vertex>', FAR_BEGIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFarCol;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vFarCol, opacity );');
  };
  m.customProgramCacheKey = () => 'leonida-human-far-1';
  return m;
}

// materials are shared by every batch (player, pedestrians, remote avatars): one shader program set,
// compiled once at init (no material creation later = no compile hitches)
let MATS = null;
export function humanMaterials() {
  if (!MATS) MATS = { human: humanMaterial(), depth: humanDepthMaterial(), far: farMaterial() };
  return MATS;
}

const FAR_STRIDE = 14;
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class HumanBatch {
  /**
   * @param {THREE.Object3D} scene
   * @param {number} capacity max figures
   * @param {{far?: boolean, mid?: boolean, shadows?: boolean}} [opts]
   */
  constructor(scene, capacity, { far = true, mid = true, shadows = true } = {}) {
    this.cap = capacity;
    this.used = new Uint8Array(capacity);
    this.hi = 0;
    this.group = new THREE.Group();
    this.group.name = 'humans';
    scene.add(this.group);
    const G = geometries();
    const mats = humanMaterials();
    this.material = mats.human;
    this.depth = mats.depth;
    // per-slot look data (copied into the instance buffers of whatever is drawn this frame)
    this.cache = {};
    for (const [k, n] of Object.entries(MESH_MULT)) this.cache[k] = new Float32Array(capacity * n * STRIDE);
    this.farCache = new Float32Array(capacity * 12);
    this.sets = {};
    this.sets.near = this._makeSet('near', SETS.near, G, shadows, '');
    if (mid) {
      this.sets.midS = this._makeSet('mid', SETS.mid, G, shadows, 'S');
      this.sets.mid = this._makeSet('mid', SETS.mid, G, false, '');
    }
    this.far = null;
    if (far) {
      const geo = shareGeometry(G.far);
      const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * FAR_STRIDE), FAR_STRIDE, 1);
      buf.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iColA', new THREE.InterleavedBufferAttribute(buf, 3, 0));
      geo.setAttribute('iColB', new THREE.InterleavedBufferAttribute(buf, 3, 3));
      geo.setAttribute('iColC', new THREE.InterleavedBufferAttribute(buf, 3, 6));
      geo.setAttribute('iHair', new THREE.InterleavedBufferAttribute(buf, 3, 9));
      geo.setAttribute('iAnim', new THREE.InterleavedBufferAttribute(buf, 2, 12));
      const mesh = new THREE.InstancedMesh(geo, mats.far, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = 'human:far';
      this.group.add(mesh);
      this.far = { mesh, buf, mat: mesh.instanceMatrix.array, n: 0, tris: triCount(G.far) };
    }
  }

  _makeSet(lod, list, G, shadows, suffix) {
    const meshes = [], entries = [];
    list.forEach(([geoKey, srcs, bits], mi) => {
      const srcList = Array.isArray(srcs) ? srcs : [srcs];
      const n = this.cap * srcList.reduce((a, k) => a + MESH_MULT[k], 0);
      const geo = shareGeometry(G[geoKey]);
      const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(n * STRIDE), STRIDE, 1);
      buf.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iColA', new THREE.InterleavedBufferAttribute(buf, 3, 0));
      geo.setAttribute('iColB', new THREE.InterleavedBufferAttribute(buf, 3, 3));
      geo.setAttribute('iColC', new THREE.InterleavedBufferAttribute(buf, 3, 6));
      geo.setAttribute('iCloth', new THREE.InterleavedBufferAttribute(buf, 4, 9));
      geo.setAttribute('iShape', new THREE.InterleavedBufferAttribute(buf, 2, 13));
      const mesh = new THREE.InstancedMesh(geo, this.material, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.depth;
      mesh.name = `human:${geoKey}${suffix}`;
      this.group.add(mesh);
      meshes.push({ mesh, buf, mat: mesh.instanceMatrix.array, n: 0, bits, tris: triCount(G[geoKey]) });
      // which rig parts this mesh draws (and where their look data lives)
      PARTS.forEach((p, pi) => { if (srcList.includes(p.mesh)) entries.push({ m: mi, part: pi, k: p.k, src: p.mesh, mult: MESH_MULT[p.mesh] }); });
    });
    return { lod, meshes, entries };
  }

  alloc() {
    for (let i = 0; i < this.cap; i++) {
      if (!this.used[i]) {
        this.used[i] = 1;
        if (i >= this.hi) this.hi = i + 1;
        return i;
      }
    }
    return -1;
  }

  release(slot) {
    if (slot < 0 || !this.used[slot]) return;
    this.used[slot] = 0;
    while (this.hi > 0 && !this.used[this.hi - 1]) this.hi--;
  }

  // per-figure look data from looks.lookData()
  setLook(slot, data) {
    for (const [k, a] of Object.entries(this.cache)) a.set(data.mesh[k], slot * MESH_MULT[k] * STRIDE);
    this.farCache.set(data.far, slot * 12);
  }

  /**
   * Draw a figure this frame. W = joint world matrices (NJ*12), d = dims.
   * lod 0 = full detail, 1 = mid; shadow: cast shadows (mid only, near always casts).
   */
  writeFigure(slot, W, d, lod = 0, shadow = true) {
    const set = lod === 0 || !this.sets.mid ? this.sets.near : shadow ? this.sets.midS : this.sets.mid;
    const L = d.parts;
    const meshes = set.meshes, entries = set.entries;
    for (let ei = 0; ei < entries.length; ei++) {
      const en = entries[ei];
      const m = meshes[en.m];
      const src = this.cache[en.src];
      const so = (slot * en.mult + en.k) * STRIDE;
      if (m.bits && (((src[so + 14] + 0.5) | 0) & m.bits) === 0) continue;
      const idx = m.n++;
      const dst = m.buf.array, dofs = idx * STRIDE;
      for (let q = 0; q < STRIDE; q++) dst[dofs + q] = src[so + q];
      const b = PARTS[en.part].joint * 12, l = en.part * 7;
      const sx = L[l + 3], sy = L[l + 4], sz = L[l + 5], tx = L[l], ty = L[l + 1], tz = L[l + 2];
      const a = m.mat, o = idx * 16;
      const r00 = W[b], r10 = W[b + 1], r20 = W[b + 2], r01 = W[b + 3], r11 = W[b + 4], r21 = W[b + 5];
      const r02 = W[b + 6], r12 = W[b + 7], r22 = W[b + 8];
      a[o] = r00 * sx; a[o + 1] = r10 * sx; a[o + 2] = r20 * sx; a[o + 3] = 0;
      a[o + 4] = r01 * sy; a[o + 5] = r11 * sy; a[o + 6] = r21 * sy; a[o + 7] = 0;
      a[o + 8] = r02 * sz; a[o + 9] = r12 * sz; a[o + 10] = r22 * sz; a[o + 11] = 0;
      a[o + 12] = W[b + 9] + r00 * tx + r01 * ty + r02 * tz;
      a[o + 13] = W[b + 10] + r10 * tx + r11 * ty + r12 * tz;
      a[o + 14] = W[b + 11] + r20 * tx + r21 * ty + r22 * tz;
      a[o + 15] = 1;
    }
  }

  // far impostor: ground point, yaw, uniform scale (height), walk phase + amplitude, optional tilt (lying)
  writeFar(slot, x, y, z, yaw, h, phase, amp, tiltX = 0) {
    const f = this.far;
    if (!f) return;
    const idx = f.n++;
    _e.set(tiltX, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _m4.compose(_p.set(x, y, z), _q, _s.set(h, h, h));
    f.mat.set(_m4.elements, idx * 16);
    const a = f.buf.array, o = idx * FAR_STRIDE, c = slot * 12;
    for (let q = 0; q < 12; q++) a[o + q] = this.farCache[c + q];
    a[o + 12] = phase; a[o + 13] = amp;
  }

  // nothing to do: a figure that isn't written in a frame is not drawn
  hide() {}

  // upload this frame's instances and start the next frame
  flush() {
    for (const set of Object.values(this.sets)) for (const m of set.meshes) this._upload(m, STRIDE);
    if (this.far) this._upload(this.far, FAR_STRIDE);
  }

  _upload(m, stride) {
    const n = m.n;
    m.mesh.count = n;
    m.mesh.visible = n > 0;
    if (n > 0) {
      const im = m.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      m.buf.clearUpdateRanges();
      m.buf.addUpdateRange(0, n * stride);
      m.buf.needsUpdate = true;
    }
    m.n = 0;
  }

  /** Triangles / draw calls submitted by the last flush (main pass; shadow casters listed separately). */
  stats(out = { draws: 0, tris: 0, shadowDraws: 0, shadowTris: 0, instances: 0 }) {
    const add = (m) => {
      if (!m.mesh.visible) return;
      const t = m.mesh.count * m.tris;
      out.draws++; out.tris += t; out.instances += m.mesh.count;
      if (m.mesh.castShadow) { out.shadowDraws++; out.shadowTris += t; }
    };
    for (const set of Object.values(this.sets)) for (const m of set.meshes) add(m);
    if (this.far) add(this.far);
    return out;
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.group.removeFromParent();
    for (const set of Object.values(this.sets)) for (const m of set.meshes) m.mesh.dispose();
    this.far?.mesh.dispose();
  }
}

function shareGeometry(base) {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
  g.boundingSphere = base.boundingSphere;
  return g;
}

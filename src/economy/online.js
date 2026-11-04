// Multiplayer is an open garage. The tank is the only paid vehicle.
export function onlineVehiclePrice(id, price) {
  return { ...price, price: id === 'tank' ? 50000 : 0, starter: id !== 'tank' };
}

export function cashWorth(money) {
  return Number.isFinite(money) ? Math.round(Math.max(0, money)) : 0;
}

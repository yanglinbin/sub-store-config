/** geoip 官方产物地址（Loyalsoldier/geoip@release）——IP 类规则直接引用，本地不再编译 */
const GEOIP_BASE = 'https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release';

export const geoipSrs = (category) => `${GEOIP_BASE}/srs/${category}.srs`;
export const geoipMrs = (category) => `${GEOIP_BASE}/mrs/${category}.mrs`;

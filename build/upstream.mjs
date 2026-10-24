/** geoip 官方产物地址（Loyalsoldier/geoip@release）——IP 类规则直接引用，本地不再编译 */
const GEOIP_BASE = 'https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release';

export const geoipSrs = (category) => `${GEOIP_BASE}/srs/${category}.srs`;
export const geoipMrs = (category) => `${GEOIP_BASE}/mrs/${category}.mrs`;

/** MetaCubeX/meta-rules-dat：geosite（域名）与 geoip（IP）的官方预编译产物，mihomo 用 mrs、sing-box 用 srs */
const META_BASE = 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat';

export const metaMrs = (kind, name) => `${META_BASE}@meta/geo/${kind}/${name}.mrs`;
export const metaSrs = (kind, name) => `${META_BASE}@sing/geo/${kind}/${name}.srs`;

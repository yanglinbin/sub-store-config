// 生成物：由 build/emit-script.mjs 从 lib/grouping.mjs + config/regions.yaml 内联生成，勿手改。
// 用途：Sub-Store「文件 → 脚本操作」（mihomoConfig 文件，接在「从订阅添加节点」之后）。
const REGIONS = __REGIONS_JSON__;

__GROUPING_SRC__

function main(config) {
  const proxies = config.proxies || [];
  const names = proxies.map((p) => p.name);
  const defs = buildGroupDefs({ names, regions: REGIONS, style: 'mihomo' });

  config['proxy-groups'] = defs.map((d) => {
    if (d.type === 'urltest') {
      return {
        name: d.name,
        // mihomo 的类型名是 url-test（带连字符）；urltest 是 sing-box 的写法
        type: 'url-test',
        proxies: d.members,
        url: d.url,
        interval: d.interval,
        tolerance: d.tolerance,
      };
    }
    return { name: d.name, type: 'select', proxies: d.members };
  });

  return config;
}

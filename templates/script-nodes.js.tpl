// 生成物：由 build/emit-script.mjs 从 config/node-filter.yaml 内联生成，勿手改。
// 用途：Sub-Store「订阅 → 节点操作 → 脚本操作」（函数式 operator），负责节点清理：
//   1) 剔除信息节点（剩余流量/官网/到期…）
//   2) 按 name+server+port 去重
//   3) 按名称升序
const EXCLUDE = __EXCLUDE_REGEX__;

function operator(proxies) {
  const list = Array.isArray(proxies) ? proxies : [];
  const seen = Object.create(null);
  const out = [];
  for (const proxy of list) {
    if (!proxy || !proxy.name) continue;
    if (EXCLUDE.test(proxy.name)) continue;
    const key = [proxy.name, proxy.server, proxy.port].join('|');
    if (seen[key]) continue;
    seen[key] = true;
    out.push(proxy);
  }
  out.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));
  return out;
}

// 生成物：由 build/emit-script.mjs 从 lib/grouping.mjs + config/regions.yaml 内联生成，勿手改。
// 用途：Sub-Store「文件 → 脚本操作」（普通 file + 远程模板）。参数：#name=<订阅名>
// 注意：本文件靠顶层 await 完成工作（Sub-Store 会把脚本内联进 async 函数体），
//      不要包成 (async () => { ... })() 悬浮 Promise，否则 $content 会在赋值前被读取。
const REGIONS = __REGIONS_JSON__;

__GROUPING_SRC__

const { name } = $arguments || {};
if (!name) throw new Error('脚本参数缺少 name（订阅名）');

const config = JSON.parse($files[0]);
const artifact = await produceArtifact({
  type: 'subscription',
  name,
  platform: 'sing-box',
  produceType: 'internal',
});
// internal 约定是数组；也兼容 { outbounds, endpoints } 形态
const nodes = Array.isArray(artifact)
  ? artifact
  : artifact && Array.isArray(artifact.outbounds)
    ? artifact.outbounds
    : [];

const tags = nodes.filter((n) => n && n.tag).map((n) => n.tag);
const defs = buildGroupDefs({ names: tags, regions: REGIONS, style: 'singbox' });
const groupTags = ['proxies', 'direct', 'f1tv', 'final'];

const regionOutbounds = defs
  .filter((d) => d.type === 'urltest')
  .map((d) => ({
    type: 'urltest',
    tag: d.name,
    outbounds: d.members,
    url: d.url,
    interval: d.interval + 's',
    tolerance: d.tolerance,
  }));

const selectOutbounds = defs
  .filter((d) => d.type === 'select')
  .map((d) => {
    const out = {
      type: 'selector',
      tag: d.name,
      outbounds: d.members,
      interrupt_exist_connections: true,
    };
    if (d.default) out.default = d.default;
    return out;
  });

// 顺序 = 客户端显示顺序：节点 → 四个 select（proxies/f1tv/direct/final）→ 地区组 → 其余静态 outbound
config.outbounds = [
  ...nodes,
  ...selectOutbounds,
  ...regionOutbounds,
  ...config.outbounds.filter((o) => groupTags.indexOf(o.tag) === -1),
];

$content = JSON.stringify(config, null, 2);

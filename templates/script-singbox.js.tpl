// 生成物：由 build/emit-script.mjs 从 lib/grouping.mjs + config/regions.yaml 内联生成，勿手改。
// 用途：Sub-Store「文件 → 脚本操作」（普通 file + 远程模板）。参数：#{name=<订阅名>}
(async () => {
  const REGIONS = __REGIONS_JSON__;

  __GROUPING_SRC__

  const { name } = $arguments || {};
  if (!name) throw new Error('脚本参数缺少 name（订阅名）');

  const config = JSON.parse($files[0]);
  const nodes =
    (await produceArtifact({
      type: 'subscription',
      name,
      platform: 'sing-box',
      produceType: 'internal',
    })) || [];

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
      const out = { type: 'selector', tag: d.name, outbounds: d.members };
      if (d.default) out.default = d.default;
      return out;
    });

  config.outbounds = [
    ...nodes,
    ...regionOutbounds,
    ...selectOutbounds,
    ...config.outbounds.filter((o) => groupTags.indexOf(o.tag) === -1),
  ];

  $content = JSON.stringify(config, null, 2);
})();

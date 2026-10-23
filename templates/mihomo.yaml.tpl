# 生成物：由 build/render-mihomo.mjs 渲染，勿手改
mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
ipv6: true
external-controller: ":9090"
unified-delay: true
tcp-concurrent: true
find-process-mode: strict
profile:
  store-selected: true
  store-fake-ip: false
proxies: []
proxy-providers: {}
rule-providers: {{RULE_PROVIDERS}}
proxy-groups: {{PROXY_GROUPS_FALLBACK}}
rules: {{RULES}}

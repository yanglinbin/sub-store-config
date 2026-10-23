{
  "log": { "level": "info", "timestamp": true },
  "http_clients": [{ "tag": "direct-download", "detour": "DIRECT" }],
  "dns": {
    "servers": [
      { "type": "https", "tag": "local-dns", "server": "223.5.5.5", "path": "/dns-query" },
      { "type": "https", "tag": "remote-dns", "server": "1.1.1.1", "path": "/dns-query", "detour": "proxies" },
      { "type": "fakeip", "tag": "fakeip", "inet4_range": "198.18.0.0/15", "inet6_range": "fc00::/18" }
    ],
    "rules": [
      { "domain_suffix": [".lan", ".local", ".direct", ".localhost"], "server": "local-dns" },
      { "domain_keyword": ["time", "ntp"], "server": "local-dns" },
      { "query_type": ["A", "AAAA"], "server": "fakeip" }
    ],
    "final": "remote-dns",
    "strategy": "prefer_ipv4"
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      "auto_route": true,
      "strict_route": true,
      "stack": "mixed",
      "mtu": 1400
    },
    { "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 7890 }
  ],
  "outbounds": [
    { "type": "selector", "tag": "proxies", "outbounds": ["DIRECT"], "default": "DIRECT", "interrupt_exist_connections": true },
    { "type": "selector", "tag": "direct", "outbounds": ["DIRECT"], "interrupt_exist_connections": true },
    { "type": "selector", "tag": "f1tv", "outbounds": ["DIRECT"], "interrupt_exist_connections": true },
    { "type": "selector", "tag": "final", "outbounds": ["DIRECT"], "default": "DIRECT", "interrupt_exist_connections": true },
    { "type": "direct", "tag": "DIRECT" }
  ],
  "route": {
    "auto_detect_interface": true,
    "default_http_client": "direct-download",
    "default_domain_resolver": "local-dns",
    "final": "final",
    "rule_set": {{RULE_SET}},
    "rules": {{RULES}}
  },
  "experimental": {
    "cache_file": { "enabled": true, "store_fakeip": true },
    "clash_api": { "external_controller": "127.0.0.1:9090" }
  }
}

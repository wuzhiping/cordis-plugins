# tools/s2t —— 简体 → 繁体(zh-TW 惯用)批处理

随 `scene-template` bundle 一起放在 `cordis-plugins/scene-template/tools/s2t/`，
给**这个 bundle** 做**一次性**简繁转换(下面所有命令都以 bundle 根目录为当前目录)。
产出是"源码里就是繁体字面量"，交付物不带任何运行时转换表。

## 两张字表 + 一张手工表

| 层 | 来源 | 强项 | 短板 |
|---|---|---|---|
| 词条/字表 | [`zhtw-traditional-chinese`](../../../zhtw-traditional-chinese) bundle 里的 `S2T_PHRASES` / `S2T_CHARS`（运行时直接读它的源码，不复制） | 台湾惯用词与歧义字：`设置→設定`、`拖动→拖曳`、`界面→介面`、`重新整理`、`后→後` | 字不全（缺 `数/触/达/点/题/线/评/价`…） |
| 字表兜底 | `winmap.json`：Windows `LCMapString(LCMAP_TRADITIONAL_CHINESE)` 对"文件里出现的每个汉字"逐个转换的结果 | 字级全量 | 只看字不看词，且保守保留"在繁体里也合法"的字（`后/里/台/于/么/周/采/舍/范/松`） |
| 手工表 | `convert.js` 里的 `POLISH` / `GUARD` | 收尾：`怎么→怎麼`、`在于→在於`、`本周→本週`、`复数→複數`、`占位符→佔位符`、`范围→範圍`；`里程碑` 整词保护 | 需要人判断，逐条写了理由 |

顺序：**整词保护 → 词条 → 字表 → POLISH → 还原保护**。

## 用法

```sh
# 1) 先生成字表兜底(必须在"还是简体"的时候跑)
powershell -File tools/s2t/winmap.ps1 -Files lib/client.js

# 2) 干跑:打印改动行数 + "转换后仍可被表改写的字"(必须为 0)
node tools/s2t/convert.js --report <file...>

# 3) 原地转换
node tools/s2t/convert.js --write <file...>

# 4) 只对已转好的文件补跑手工表(后来才发现某个惯用写法要改时用)
node tools/s2t/convert.js --polish <file...>

# 5) 打印"只覆盖这些文件所需"的最小词表 —— 给动态插件用(它没法读文件，只能内联)
node tools/s2t/convert.js --emit-table <file...>
```

## 两个已经验证过的性质

- **审计为 0**：`--report` 的判据不是"像不像繁体"，而是"还有没有字能被任何一张表改写"。
- **幂等**：对已转好的文件再跑 `--write` 输出 `skip (no change)` —— 说明三张表之间没有互相打架。

## 已知的"故意不改"

- 标点是半角 `,` `:` 与空格（沿用 mock 数据的排版，没有做全角化）。
- `注釋`（`註釋` 也对）、`周` 在非"星期"语境下的保留写法，这些不影响阅读，没进 POLISH。

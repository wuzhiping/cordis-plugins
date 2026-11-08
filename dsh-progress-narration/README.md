<p align="center">
  <img src="https://raw.githubusercontent.com/jevonhou/dsh-progress-narration/main/design/banner.png" alt="过程播报 · DeepSeek Harness 插件" width="100%" />
</p>

<h1 align="center">过程播报 · dsh-progress-narration</h1>

<p align="center"><strong>让 DSH 边干活，边在对话里报个进度。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-plugin-progress-narration"><img alt="npm" src="https://img.shields.io/npm/v/dsh-plugin-progress-narration?style=flat-square&color=cb3837"></a>
  <a href="package.json"><img alt="源码版本" src="https://img.shields.io/badge/source-0.2.11-blue?style=flat-square"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1%2B-111?style=flat-square">
</p>

<p align="center"><a href="README.en.md">English</a> · 中文</p>

---

## 为什么做「过程播报」

我看着 DSH 跑了五分钟命令，工具记录刷个不停，一句正文都没等到。我只知道它还在跑，完全不知道事情做到哪一步了。

过程播报会提醒 DSH 在任务途中说两句。比如「找到问题了，我先修这儿」，或者「改好了，我跑一下测试」。

## 使用

点击会话输入框右侧的气泡图标，选择播报频率。可以点击档位，也可以拖动胶囊，松手后生效。用方向键也能选档，按 Esc 关闭面板。气泡图标会随已保存的档位变化，面板右上角的圆形箭头可恢复默认档位。

| 档位 | 建议的播报节奏 |
|---|---|
| 克制 | 开始前和关键节点简短说明 |
| 标准（默认） | 大约每两三步同步一次 |
| 话多 | 尽量在每个步骤完成后同步 |

![播报频率设置面板](https://raw.githubusercontent.com/jevonhou/dsh-progress-narration/main/design/slider-preview.png)

![三个播报档位的气泡图标](https://raw.githubusercontent.com/jevonhou/dsh-progress-narration/main/design/trigger-icons.png)

默认只对主代理启用播报提醒。播报越频繁，模型的输出 token 通常越多。

## 安装

需要 DeepSeek Harness `0.2.2-rc.1` 或更新版本。已在 macOS 上验证，其他平台尚未实测。

1. 打开「设置 → 插件」，点击「添加插件」。
2. 输入 [GitHub 仓库地址](https://github.com/jevonhou/dsh-progress-narration)，按提示安装当前源码版本。
3. 回到会话，确认输入框右侧出现带点的气泡图标。

安装入口也接受本地仓库的绝对路径。若要安装 npm 已发布版本，输入 `dsh-plugin-progress-narration`，具体版本见上方 npm 徽章。

如需卸载，在「设置 → 插件 → 过程播报」中选择「卸载」。

## 开发

插件使用 JavaScript，直接在 Harness 中运行，无需单独构建。

| 文件 | 作用 |
|---|---|
| `index.js` | 播报提示、提醒和设置定义 |
| `client.js` | 气泡图标与播报频率面板 |
| `cordis.patch.yml` | Harness 插件注册配置 |
| `locale/` | 插件列表的标题与说明（简体、繁體、English、Tiếng Việt） |

`index.js` 会按档位检查模型是否连续只调用工具。克制、标准、话多分别达到 6、3、2 步时，下一次请求会带上简短提醒。

本地调试时，在「添加插件」中输入仓库的绝对路径。修改 `client.js` 后完整退出并重新打开 Harness，再核对实际界面。若仍显示旧内容，先确认插件来源指向当前源码目录。

界面约定见 [设计规范](DESIGN.md)。在源码仓库运行 `node --test` 可检查档位点击、拖动提交和取消。

## 许可证

[MIT](LICENSE)

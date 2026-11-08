<p align="center">
  <img src="https://raw.githubusercontent.com/jevonhou/dsh-progress-narration/main/design/banner.png" alt="Progress narration for DeepSeek Harness" width="100%" />
</p>

<h1 align="center">Progress Narration · dsh-progress-narration</h1>

<p align="center"><strong>Get quick updates from DSH while it works.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-plugin-progress-narration"><img alt="npm" src="https://img.shields.io/npm/v/dsh-plugin-progress-narration?style=flat-square&color=cb3837"></a>
  <a href="package.json"><img alt="Source version" src="https://img.shields.io/badge/source-0.2.11-blue?style=flat-square"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1%2B-111?style=flat-square">
</p>

<p align="center">English · <a href="README.md">中文</a></p>

---

## Why Progress Narration exists

I watched DSH run commands for five minutes without a word in the chat. The tool log kept scrolling. I could see it was still running, but I had no idea how far it had gotten.

Progress Narration nudges DSH to check in as it works. You might see “Found the problem. I’ll fix that first” or “The fix is in. I’ll run the tests now.”

## Usage

Click the speech bubble to the right of the message box to choose how often to get updates. Click a mode or drag the pill and release it to apply your choice. You can also use the arrow keys and press Esc to close the panel. The bubble reflects the saved mode, and the circular arrow in the panel restores the default.

| Mode | Suggested frequency |
|---|---|
| Quiet (克制) | Before starting and at key points |
| Standard (标准, default) | About every two or three steps |
| Chatty (话多) | After each completed step when possible |

![Update frequency panel](https://raw.githubusercontent.com/jevonhou/dsh-progress-narration/main/design/slider-preview.png)

![Speech bubble icons for the three modes](https://raw.githubusercontent.com/jevonhou/dsh-progress-narration/main/design/trigger-icons.png)

By default, reminders apply to the main agent only. More frequent updates generally use more output tokens.

## Install

Requires DeepSeek Harness `0.2.2-rc.1` or newer. Tested on macOS. Other platforms have yet to be tested.

1. Open **Settings → Plugins** and click **Add plugin**.
2. Enter the [GitHub repository URL](https://github.com/jevonhou/dsh-progress-narration) and follow the prompts to install the current source version.
3. Return to a conversation and look for the dotted speech bubble to the right of the message box.

The same dialog accepts the absolute path to a local checkout. To install the published npm version, enter `dsh-plugin-progress-narration`. The npm badge above shows that version.

To remove the plugin, open **Settings → Plugins → Progress narration** and choose **Uninstall**.

## Development

The plugin is written in JavaScript and runs directly in Harness without a build step.

| File | Role |
|---|---|
| `index.js` | Progress prompts, reminders, and settings |
| `client.js` | Speech bubble and update frequency panel |
| `cordis.patch.yml` | Harness plugin registration |
| `locale/` | English and Chinese names and descriptions |

`index.js` counts consecutive steps in which the model only calls tools. When the count reaches 6, 3, or 2 in Quiet, Standard, or Chatty mode, respectively, the next model request includes a short reminder.

For local development, enter the absolute path to the checkout in **Add plugin**. After editing `client.js`, quit and reopen Harness, then check the interface. If it still shows the previous version, confirm that the plugin points to your current checkout.

See the [design guidelines](DESIGN.md) for the panel. Run `node --test` from the source checkout to check clicking, committing a drag, and canceling a drag.

## License

[MIT](LICENSE)

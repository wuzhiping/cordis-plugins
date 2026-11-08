/**
 * 过程播报（progress narration）Host 半边。
 *
 * 只做两件事，都走 Harness 的正规扩展点：
 * 1. 一条常驻的系统提示段 `narration:policy`，告诉模型「正文在哪里、多久说一次、说什么」。
 * 2. 一条动态运行上下文 `narration:silence`：扫描会话历史，发现模型连续 N 步只调工具、
 *    没有给用户任何正文时，在下一步请求里插入提醒。这条提醒只在越线时出现，平时不占提示词。
 *
 * 不注入伪造的用户消息，不改 profile 文件；用户偏好由插件页的配置表单与输入框旁的浮层写入。
 */

import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * 软链安装的插件解析不到 profile 的依赖，所以按 profile 目录拿 schemastery。
 * 运行进程里 DSH_* 环境变量不一定存在，因此依次尝试：
 * 环境变量 → ~/.dsh/profiles/* 里能解析到的那个 → 插件自身。
 * 全都失败时返回 null：插件继续工作，只是没有可写的配置表单。
 */
function loadSchemastery() {
  const bases = [];
  const preferEnv = [];
  if (process.env.DSH_PROFILE_DIR) preferEnv.push(`${process.env.DSH_PROFILE_DIR}/package.json`);
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    preferEnv.push(`${process.env.DSH_HOME}/profiles/${process.env.DSH_PROFILE}/package.json`);
  }
  const profilesRoot = `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/profiles`;
  const discovered = [];
  try {
    for (const name of readdirSync(profilesRoot)) discovered.push(`${profilesRoot}/${name}/package.json`);
    discovered.push(`${profilesRoot}/package.json`);
  } catch {
    /* 没有 profiles 目录时只试其他候选 */
  }
  bases.push(...preferEnv, ...discovered);

  for (const base of bases) {
    try {
      const required = createRequire(base)('@deepseek-ai/schemastery');
      const candidate = required?.default ?? required;
      if (candidate !== null && typeof candidate?.object === 'function') return candidate;
    } catch {
      /* 换下一个候选 */
    }
  }
  try {
    const required = createRequire(import.meta.url)('@deepseek-ai/schemastery');
    const candidate = required?.default ?? required;
    if (candidate !== null && typeof candidate?.object === 'function') return candidate;
  } catch {
    /* 插件自带依赖可用时才会走到这里 */
  }
  return null;
}

const z = loadSchemastery();

/** @typedef {{ mode?: 'gentle' | 'balanced' | 'chatty', everySteps?: number, rootsOnly?: boolean }} Config */

const MODES = ['gentle', 'balanced', 'chatty'];

/** 播报规则的静态段落按强度给出不同节奏。 */
const POLICIES = {
  gentle: [
    '## 过程播报',
    '',
    '用户看到的是你的正文回复；推理（思考）会被折叠成灰色的过程行，不算「反馈」。不需要每步都说话，但关键转折必须说。',
    '',
    '- 在开始动手前、以及在得到一个改变判断的发现后，用 1–2 句正文说明：现在在做什么、刚发现了什么、接下来往哪走。正文可以和工具调用写在同一回复里。',
    '- 大致保持每 4–6 次工具调用有一次播报；某一步要等很久（构建、生成、后台任务）时，开始前先说清在等什么。',
    '- 修改文件、删除数据、安装依赖、重启服务之前，用一句话说明改动范围和原因。',
    '- 播报要具体：给结论和事实（例如「接口返回 403，鉴权头没带」），不要空话，也不要复述工具输出。',
    '- 最终回答独立完整，不重复播报内容。',
  ].join('\n'),
  balanced: [
    '## 过程播报',
    '',
    '用户看到的是你的正文回复；推理（思考）会被折叠成灰色的过程行，不算「反馈」。不要把解释全部攒到最后一轮。',
    '',
    '- 每完成一个可观察的阶段——读完一批文件、跑完一组命令、得出一个关键判断、即将动手改动——先用 1–2 句正文说明：刚才发生了什么、发现了什么、下一步做什么。正文可以和工具调用写在同一回复里。',
    '- 长任务里大致保持每 2–3 次工具调用有一次播报；某一步要等很久（构建、生成、后台任务）时，开始前先说清在等什么。',
    '- 修改文件、删除数据、安装依赖、重启服务之前，用一句话说明改动范围和原因。',
    '- 播报要具体：给结论和事实（例如「接口返回 403，鉴权头没带」），不要空话（「我接下来将会继续进行…」），也不要复述工具输出。',
    '- 最终回答独立完整，不重复播报内容；播报里也不要提前给出最终答案。',
  ].join('\n'),
  chatty: [
    '## 过程播报',
    '',
    '用户看到的是你的正文回复；推理（思考）会被折叠成灰色的过程行，不算「反馈」。请把工作过程讲出来。',
    '',
    '- 每完成一步（一次读取、一次命令、一个判断）就用 1–2 句正文说明：刚才做了什么、发现了什么、下一步做什么。正文可以和工具调用写在同一回复里。',
    '- 需要等待的操作（构建、生成、后台任务）开始前先说清在等什么，等到了再说结果。',
    '- 修改文件、删除数据、安装依赖、重启服务之前，用一句话说明改动范围和原因。',
    '- 播报要具体、有信息量：给结论和事实，不要空话，也不要复述工具输出。',
    '- 最终回答独立完整，不重复播报内容。',
  ].join('\n'),
};

/** 越线提醒；由代码拼数字，不使用提示词变量语法。 */
function reminderText(silentSteps) {
  return [
    `[播报提醒] 你已经连续 ${silentSteps} 步只调用工具、没有给用户任何正文。`,
    '这次回复先写 1–2 句正文，说明刚才做了什么、发现了什么、下一步做什么，再继续调用工具。',
  ].join('\n');
}

/** 允许直接写中文，避免配置里出现英文术语。 */
const MODE_ALIASES = {
  克制: 'gentle',
  标准: 'balanced',
  话多: 'chatty',
  quiet: 'gentle',
  normal: 'balanced',
  verbose: 'chatty',
};

/** 规范化强度，未知值回落到 balanced。 */
function normalizeMode(mode) {
  if (typeof mode !== 'string') return 'balanced';
  const value = mode.trim().toLowerCase();
  if (MODES.includes(value)) return value;
  return MODE_ALIASES[mode.trim()] ?? 'balanced';
}

/** 提醒阈值跟随语气：越克制越容忍沉默，不需要用户单独理解这个机制。 */
const REMIND_EVERY = { gentle: 6, balanced: 3, chatty: 2 };

/**
 * 数一数「连续多少个已完成的助手步骤只调了工具、一个字也没说」。
 * 历史来自 Session 的派生消息（有缓存，只走增量），从尾部往前看：
 * 跳过工具结果，遇到带正文的助手消息或用户消息就停。
 */
function countSilentSteps(session) {
  let messages;
  try {
    messages = session.deriveMessages();
  } catch {
    return 0;
  }
  let silent = 0;
  for (let index = messages.length - 1; index >= 0 && silent < 12; index -= 1) {
    const message = messages[index];
    if (message === undefined) break;
    if (message.role === 'tool') continue;
    if (message.role !== 'assistant') break;
    const parts = Array.isArray(message.content) ? message.content : [];
    const hasToolCalls = parts.some((part) => part?.type === 'tool-call' && typeof part.name === 'string');
    if (!hasToolCalls) break;
    const text = parts
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (text.length > 0) break;
    silent += 1;
  }
  return silent;
}

/**
 * 可写字段：声明为 volatile，插件页的配置表单和输入框旁的浮层都能直接读写，
 * 改完立即生效，不需要重启插件。
 */
export const Config = z === null ? undefined : z.object({
  mode: z
    .union(['gentle', 'balanced', 'chatty', '克制', '标准', '话多'])
    .default('balanced')
    .volatile()
    .description('说话密度'),
});

/** 读取 volatile 引用或普通值。 */
function readValue(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get() ?? fallback;
  }
  return value ?? fallback;
}

/**
 * 注册播报规则与越线提醒。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {Config} [config] - loader 行配置；volatile 字段是引用。
 */
export function apply(ctx, config = {}) {
  const rootsOnly = config.rootsOnly !== false;
  const mode = () => normalizeMode(readValue(config.mode, 'balanced'));
  const everySteps = () => REMIND_EVERY[mode()] ?? 3;

  ctx.systemPrompt.section({
    name: 'narration:policy',
    order: 10300,
    text: () => POLICIES[mode()],
  });

  ctx.systemPrompt.context({
    name: 'narration:silence',
    order: 9000,
    text(context) {
      const threshold = everySteps();
      const agent = context?.agent;
      if (agent === undefined || agent === null) return '';
      try {
        if (rootsOnly && !ctx.agents.roots().includes(agent)) return '';
        const silentSteps = countSilentSteps(agent.session);
        return silentSteps >= threshold ? reminderText(silentSteps) : '';
      } catch {
        return '';
      }
    },
  });
}

export const inject = ['systemPrompt', 'agents'];

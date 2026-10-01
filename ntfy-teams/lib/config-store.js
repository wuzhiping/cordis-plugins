'use strict';

// =============================================================================
// 团队协同 · ntfy-teams —— 设定储存（YAML，落在外挂目录旁）
//
// 为什么要有这一层：
//
//   原本「伺服器、帐密、主题清单」全部躺在浏览器 localStorage。它的寿命跟
//   浏览器设定绑定 —— 换 profile、清快取、换机器就没了。这些是团队协作的**身份
//   与连线资讯**，应该跟外挂一起落成看得见、改得动、能备份的档案。
//
// 两个档案，因为凭证不该跟一般设定混在一起：
//
//   config.yml   可安心分享：伺服器、主题清单、别名、看板宽度、发送者身分
//   secrets.yml  只有帐号密码／token，单独一份并收紧权限
//
//   拆开的好处是「我想给你我的设定」不会顺手把密码也给出去。
//
// 安全说明（不回避）：
//
//   * `secrets.yml` 是**明文**，依使用者选择如此。因此写入时一律 chmod 0600
//     （Windows 上尽最大努力），并靠 .gitignore 挡住版本控制。
//   * chmod 在 Windows 上不是完整的保护：同机器的其他使用者仍可能读到。
//     真正敏感的凭证建议改用宿主既有的 credentials 服务（本层不涉及）。
//   * 永远不把 secrets 的内容写进 log／错误讯息。
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

/** 设定档名（不含目录）。 */
const CONFIG_FILE = 'config.yml';
/** 凭证档名（不含目录）。单独一份，权限收紧。 */
const SECRETS_FILE = 'secrets.yml';
/** 凭证档的权限：只有拥有人可读写。 */
const SECRETS_MODE = 0o600;
/** 一般设定档权限：拥有者可读写，其他只读。 */
const CONFIG_MODE = 0o644;

/**
 * 优先用 js-yaml（宿主自带），拿不到就退回内建的极简实作。
 *
 * 不把 js-yaml 列为依赖的理由：从外挂目录 `require` 不到它（实测 MISS），
 * 它只是 dsh 的传递依赖。写死依赖一个不属于自己的套件很脆弱，所以做成可选加强。
 *
 * @returns js-yaml 模组或 null。
 */
function loadYaml() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('js-yaml');
    if (mod && typeof mod.load === 'function' && typeof mod.dump === 'function') return mod;
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * 这个行程实际要用的 YAML 实作，**只决定一次**。
 *
 * 为什么钉住：写与读若用了不同实作，就可能写出自己读不回来的档案。
 * 实测踩过 —— 内建 emitter 的输出被另一个 parser 读成字串，设定静默变形。
 * 两个方向共用同一个决定，就不会有这种组合。
 */
const YAML_LIB = loadYaml();

/**
 * 这个行程有没有用上 js-yaml（没有就是走内建实作）。
 *
 * @returns { usingLibrary, label }。
 */
function yamlBackend() {
  return {
    usingLibrary: !!YAML_LIB,
    label: YAML_LIB ? 'js-yaml' : 'builtin'
  };
}

/* ------------------------------------------------------------ 极简 YAML 实作 */

/**
 * 把值序列化成 YAML 子集（纯量／阵列／映射）。
 *
 * 缩排规则：**回传的每一行都已经带好该有的缩排**，呼叫方直接串起来即可。
 * （早期版本由呼叫方再补一次缩排，导致阵列项目被缩两层 —— 实测踩过。）
 *
 * 支援的结构刻意限制在设定档真正需要的形状。不支援锚点、多行折叠等进阶语法 ——
 * 那些手写容易出错，宁可不要有。
 *
 * @param value - 任意值。
 * @param indent - 目前缩排层级。
 * @returns YAML 字串（可多行）。
 */
function dumpYaml(value, indent) {
  return renderYaml(value, indent || 0);
}

/**
 * 真正的序列化实作。
 *
 * 关键：**用结构决定排版，不要事后猜文字**。
 * 早期版本靠「输出里有没有 `: `」来判断能不能内联，结果阵列的
 * `  - pub_demo` 被误判成可以内联，写出 `topics:   - pub_demo` —— 读回来变成字串。
 * 现在由 `isScalar` 直接看值本身的型别：只有纯量能跟键或清单符号同一行，
 * 映射与阵列一律换行（它们的首行已经带好自己的缩排）。
 *
 * @param value - 任意值。
 * @param level - 目前缩排层级。
 * @returns YAML 字串。
 */
function renderYaml(value, level) {
  const pad = '  '.repeat(level);

  if (value === null || value === undefined) return pad + 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return pad + String(value);
  if (typeof value === 'string') return pad + quoteScalar(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => {
      if (isScalarValue(item)) return pad + '- ' + renderYaml(item, 0);
      // 容器：清单符号自己一行，内容缩一层
      return pad + '-\n' + renderYaml(item, level + 1);
    }).join('\n');
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys.map((key) => {
      const v = value[key];
      // 空容器写成同一行（`key: {}` / `key: []`）—— 这样它在读取时走纯量那条路，
      // 不需要「缩排的独立空容器」那种更容易出错的分支。
      const isEmptyContainer = (Array.isArray(v) && v.length === 0)
        || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
      if (isScalarValue(v) || isEmptyContainer) {
        const rendered = isEmptyContainer ? (Array.isArray(v) ? '[]' : '{}') : renderYaml(v, 0);
        return pad + quoteKey(key) + ': ' + rendered;
      }
      return pad + quoteKey(key) + ':\n' + renderYaml(v, level + 1);
    }).join('\n');
  }

  return pad + quoteScalar(String(value));
}

/**
 * 这个值能不能跟键或清单符号挤在同一行。
 *
 * @param value - 任意值。
 * @returns 是否纯量。
 */
function isScalarValue(value) {
  if (value === null || value === undefined) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  return false;
}

/**
 * 这段序列化结果能不能跟键／清单符号放在同一行。
 *
 * 保留给测试与呼叫方使用；正式排版走 isScalarValue。
 *
 * @param rendered - 序列化结果。
 * @returns 是否可内联。
 */
function isInlineYaml(rendered) {
  const s = String(rendered);
  if (s.indexOf('\n') !== -1) return false;
  if (s === '{}' || s === '[]') return true;
  if (s.indexOf(': ') !== -1) return false;
  if (s.charAt(s.length - 1) === ':') return false;
  return true;
}

/**
 * 把纯量包成安全的形式。必要时加引号，避免被读成数字／布林／null。
 *
 * @param s - 字串。
 * @returns YAML 纯量。
 */
function quoteScalar(s) {
  const str = s === null || s === undefined ? '' : String(s);
  if (str === '') return "''";
  // 看起来像别的型别、或以特殊字元开头，就一律加引号 —— 宁愿多引号也不要被误读。
  if (/^-?\d+(\.\d+)?$/.test(str)) return "'" + str + "'";
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(str)) return "'" + str + "'";
  if (/^[\s'"#\-?:,[\]{}&*!|>%@`]/.test(str)) return "'" + str.replace(/'/g, "''") + "'";
  if (/[:#](\s|$)/.test(str)) return "'" + str.replace(/'/g, "''") + "'";
  if (/[\n\r\t]/.test(str)) return "'" + str.replace(/'/g, "''").replace(/\n/g, '\\n') + "'";
  return str;
}

/**
 * 键名一律加引号，避免 `:`、`#` 之类在键里出问题。
 *
 * @param key - 键。
 * @returns 安全的键。
 */
function quoteKey(key) {
  const k = String(key);
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) return k;
  return "'" + k.replace(/'/g, "''") + "'";
}

/**
 * 解开 YAML 纯量。
 *
 * @param raw - 原始字串。
 * @returns { value, kind }，kind 为 'object' | 'array' | 'scalar' | 'bad'。
 */
function parseScalar(raw) {
  let s = String(raw).trim();
  if (s === '') return { value: '', kind: 'scalar' };
  if (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'" && s.length >= 2) {
    return { value: s.slice(1, -1).replace(/''/g, "'").replace(/\\n/g, '\n'), kind: 'scalar' };
  }
  if (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"' && s.length >= 2) {
    return { value: s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n'), kind: 'scalar' };
  }
  if (s === '[]') return { value: [], kind: 'array' };
  if (s === '{}') return { value: {}, kind: 'object' };
  if (s === 'null' || s === '~') return { value: null, kind: 'scalar' };
  if (s === 'true') return { value: true, kind: 'scalar' };
  if (s === 'false') return { value: false, kind: 'scalar' };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { value: Number(s), kind: 'scalar' };
  return { value: s, kind: 'scalar' };
}

/**
 * 解析内建 YAML 子集。
 *
 * 只要有一行看不懂就整份放弃并回传错误 —— 静默地「尽力解析」会让使用者
 * 以为设定生效了，但实际上丢了一半，那比直接报错更难查。
 *
 * @param text - YAML 全文。
 * @returns { ok, value?, error? }。
 */
function parseYaml(text) {
  const raw = String(text === null || text === undefined ? '' : text);
  const lines = raw.split(/\r?\n/);
  const root = {};
  // 每一层用 { indent, container } 记录，靠缩排决定归属。
  const stack = [{ indent: -1, container: root }];
  let sawAny = false;

  /** @returns 这一行是阵列项目吗。 */
  const isArrayItem = (s) => s.charAt(0) === '-' && (s.length === 1 || /\s/.test(s.charAt(1)));

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.charAt(0) === '#') continue;
    if (/^---\s*$/.test(trimmed) || /^\.\.\.\s*$/.test(trimmed)) continue;

    const indent = line.length - line.replace(/^\s+/, '').length;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];

    // 独立的 {} / [] 行（内建 emitter 会把空容器写成这样）
    if (trimmed === '{}' || trimmed === '[]') {
      const parsedEmpty = parseScalar(trimmed);
      if (Array.isArray(parent.container)) {
        parent.container.push(parsedEmpty.value);
      } else if (parent === stack[0] && !sawAny) {
        // 整份档案就是一个空容器（根层），直接采用它
        root.__rootEmpty = parsedEmpty.value;
      } else {
        return { ok: false, error: '第 ' + (i + 1) + ' 行：空容器出現在不合法位置' };
      }
      sawAny = true;
      continue;
    }

    if (isArrayItem(trimmed)) {
      if (!Array.isArray(parent.container)) {
        return { ok: false, error: '第 ' + (i + 1) + ' 行：阵列项目出现在非阵列位置' };
      }
      const rest = trimmed.slice(1).trim();
      if (rest === '') {
        const child = {};
        parent.container.push(child);
        stack.push({ indent: indent, container: child });
        continue;
      }
      const kv = splitKey(rest);
      if (kv) {
        const child = {};
        parent.container.push(child);
        if (kv.value === '') {
          // "- key:" 后面还有子层
          const child2 = {};
          child[kv.key] = child2;
          stack.push({ indent: indent, container: child });
          stack.push({ indent: indent + 1, container: child2 });
        } else {
          child[kv.key] = parseScalar(kv.value).value;
          stack.push({ indent: indent, container: child });
        }
        sawAny = true;
        continue;
      }
      parent.container.push(parseScalar(rest).value);
      sawAny = true;
      continue;
    }

    const kv = splitKey(trimmed);
    if (!kv) {
      return { ok: false, error: '第 ' + (i + 1) + ' 行：看不懂的语法「' + trimmed + '」' };
    }
    if (Array.isArray(parent.container)) {
      return { ok: false, error: '第 ' + (i + 1) + ' 行：键值出现在阵列位置' };
    }
    if (kv.value === '') {
      // 空容器以 `{}` / `[]` 的形式单独占一行（内建 emitter 就是这样写的），
      // 这种情况要当成「纯量值」直接指派，不能建子层。
      //
      // 用 undefined 当「没找到」的标记，**不能用 null** ——
      // `parseScalar('{}').value` 是 `{}`，而 `{} !== null` 为 true，
      // 那种写法会让这个分支看似成立、实际却在后面又落到「独立空容器」那条路上报错。
      let child = null;
      let emptyLiteral;
      let foundEmpty = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const tj = lines[j].trim();
        if (tj === '' || tj.charAt(0) === '#') continue;
        const nextIndent = lines[j].length - lines[j].replace(/^\s+/, '').length;
        if (nextIndent <= indent) break;
        if (tj === '{}' || tj === '[]') {
          emptyLiteral = parseScalar(tj).value;
          foundEmpty = true;
        } else {
          child = isArrayItem(tj) ? [] : {};
        }
        break;
      }
      if (foundEmpty) {
        parent.container[kv.key] = emptyLiteral;
        sawAny = true;
        continue;
      }
      if (child === null) child = {};
      parent.container[kv.key] = child;
      stack.push({ indent: indent, container: child });
    } else {
      parent.container[kv.key] = parseScalar(kv.value).value;
    }
    sawAny = true;
  }

  if (root.__rootEmpty !== undefined && Object.keys(root).length === 1) {
    return { ok: true, value: root.__rootEmpty };
  }
  return { ok: true, value: sawAny ? root : {} };
}

/**
 * 把「key: value」拆成两半；不是这种形状就回 null。
 *
 * @param line - 单行（已 trim）。
 * @returns { key, value } 或 null。
 */
function splitKey(line) {
  const s = String(line);
  // 键可能是引号包起来的（键里有冒号或井号时会被加引号）
  if (s.charAt(0) === "'" || s.charAt(0) === '"') {
    const quote = s.charAt(0);
    let end = -1;
    for (let i = 1; i < s.length; i += 1) {
      if (s.charAt(i) === quote) {
        if (quote === "'" && s.charAt(i + 1) === "'") { i += 1; continue; }
        end = i;
        break;
      }
    }
    if (end === -1) return null;
    // end 是「结束引号」的索引
    const rest = s.slice(end + 1).trim();
    if (rest.charAt(0) !== ':') return null;
    let key = s.slice(1, end);
    if (quote === "'") key = key.replace(/''/g, "'");
    return { key: key, value: rest.slice(1).trim() };
  }
  const at = s.indexOf(':');
  if (at <= 0) return null;
  const key = s.slice(0, at).trim();
  if (key === '') return null;
  // 冒号后面必须接空白或结尾，否则可能只是 URL
  const after = s.charAt(at + 1);
  if (after !== '' && !/\s/.test(after)) return null;
  return { key: key, value: s.slice(at + 1).trim() };
}

/* ------------------------------------------------------------------ 档案读写 */

/**
 * 用固定的实作把值转成 YAML 文字。
 *
 * @param value - 要序列化的值。
 * @returns YAML 文字。
 */
function toYaml(value) {
  if (YAML_LIB) {
    return YAML_LIB.dump(value, { lineWidth: 200, noRefs: true });
  }
  return dumpYaml(value, 0) + '\n';
}

/**
 * 用固定的实作把 YAML 文字转成值。
 *
 * @param text - YAML 文字。
 * @returns { ok, value?, error? }。
 */
function fromYaml(text) {
  if (YAML_LIB) {
    try {
      const value = YAML_LIB.load(text);
      return { ok: true, value: value === null || value === undefined ? {} : value };
    } catch (err) {
      return { ok: false, error: 'YAML 解析失敗：' + (err && err.message ? err.message : String(err)) };
    }
  }
  return parseYaml(text);
}

/**
 * 读一个 YAML 档。
 *
 * 档案不存在回 `{ ok:true, value:null, missing:true }` —— 「还没建」不是错误。
 * 档案存在但坏掉则回 `ok:false`，**绝不**把坏档当成空档（那会把使用者设定洗掉）。
 *
 * @param file - 绝对路径。
 * @returns { ok, value?, missing?, error? }。
 */
function readYamlFile(file) {
  let text;
  try {
    if (!fs.existsSync(file)) return { ok: true, value: null, missing: true };
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, error: '讀取失敗：' + (err && err.message ? err.message : String(err)) };
  }
  if (text.trim() === '') return { ok: true, value: {}, missing: false };
  const parsed = fromYaml(text);
  if (!parsed.ok) return { ok: false, error: file + '：' + parsed.error };
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: false, error: file + '：最外層必須是鍵值對應' };
  }
  return { ok: true, value: parsed.value, missing: false };
}

/**
 * 写一个 YAML 档（原子替换 + 收紧权限）。
 *
 * 先写临时档再 rename：避免写到一半断电留下半份设定。
 * 沿用旧档的权限（若存在）或套用指定 mode。
 *
 * @param file - 绝对路径。
 * @param value - 要写的内容。
 * @param mode - 权限。
 * @returns { ok, error? }。
 */
function writeYamlFile(file, value, mode) {
  const dir = path.dirname(file);
  const tmp = file + '.tmp-' + process.pid;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const text = toYaml(value);
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: mode });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, mode);
    } catch (err) {
      // Windows 上 chmod 能力有限，写不成功不当作失败
    }
    return { ok: true };
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (ignore) { /* 清不掉就算了 */ }
    return { ok: false, error: '寫入失敗：' + (err && err.message ? err.message : String(err)) };
  }
}

/* ---------------------------------------------------------------- 对外介面 */

/**
 * 造一个绑定到某个目录的储存层。
 *
 * @param options - { dir }。
 * @returns 储存 API。
 */
function createStore(options) {
  const dir = options && options.dir ? String(options.dir) : process.cwd();
  const configPath = path.join(dir, CONFIG_FILE);
  const secretsPath = path.join(dir, SECRETS_FILE);

  return {
    dir: dir,
    configPath: configPath,
    secretsPath: secretsPath,

    /** @returns 一般设定的读取结果。 */
    readConfig() {
      return readYamlFile(configPath);
    },

    /**
     * 写一般设定。
     * @param value - 内容。
     * @returns { ok, error? }。
     */
    writeConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: '設定必須是鍵值對應' };
      }
      return writeYamlFile(configPath, value, CONFIG_MODE);
    },

    /** @returns 凭证的读取结果。 */
    readSecrets() {
      return readYamlFile(secretsPath);
    },

    /**
     * 写凭证。权限一律收紧。
     * @param value - 内容。
     * @returns { ok, error? }。
     */
    writeSecrets(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: '憑證必須是鍵值對應' };
      }
      return writeYamlFile(secretsPath, value, SECRETS_MODE);
    },

    /**
     * 同时读两份，附带「档在不在」。
     * @returns { ok, config, secrets, error? }。
     */
    readAll() {
      const c = readYamlFile(configPath);
      if (!c.ok) return { ok: false, error: c.error, config: null, secrets: null };
      const s = readYamlFile(secretsPath);
      if (!s.ok) return { ok: false, error: s.error, config: c.value, secrets: null };
      return {
        ok: true,
        config: c.value || {},
        secrets: s.value || {},
        configMissing: !!c.missing,
        secretsMissing: !!s.missing
      };
    }
  };
}

module.exports = {
  createStore,
  // 以下导出供测试直接验证细节
  __test: {
    toYaml,
    fromYaml,
    dumpYaml,
    parseYaml,
    quoteScalar,
    quoteKey,
    readYamlFile,
    writeYamlFile,
    loadYaml,
    yamlBackend,
    isInlineYaml,
    CONFIG_FILE,
    SECRETS_FILE,
    SECRETS_MODE,
    CONFIG_MODE
  }
};

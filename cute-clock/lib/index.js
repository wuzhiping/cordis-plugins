// 宿主半边 —— 本 bundle 只贡献浏览器端座位，宿主侧只需一个能加载的空壳。
// 浏览器要加载哪些模块，由宿主组合树里这一行决定（见 cordis.patch.yml）。
exports.name = 'cute-clock';
exports.apply = function () {};

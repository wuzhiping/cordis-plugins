// 宿主半邊 —— 本 bundle 只貢獻瀏覽器端座位，宿主側只需一個能載入的空殼。
// 瀏覽器要載入哪些模組，由宿主組合樹裡這一行決定（見 cordis.patch.yml）。
exports.name = 'cute-clock';
exports.apply = function () {};

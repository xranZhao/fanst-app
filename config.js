const CONFIG = {
  // DeepSeek
  API_KEY: "",
  BASE_URL: "https://api.deepseek.com/v1/chat/completions",
  READ_MODEL: "deepseek-v4-flash",
  WRITE_MODEL: "deepseek-v4-pro",
  MAX_HISTORY: 20,

  // OSS
  OSS_KEY_ID: "",
  OSS_KEY_SECRET: "",
  OSS_ENDPOINT: "oss-cn-wuhan-lr.aliyuncs.com",
  OSS_BUCKET: "fanst-library",
  OSS_INDEX: "index.json",            // 旧版全量索引（保留兼容）
  OSS_SUMMARY: "summary.json",        // 轻量统计（首屏用）
  OSS_INDEX_LITE: "index-lite.json",  // 全部书目不含 file 路径（搜索用）
  OSS_INDEX_PREFIX: "index-",         // per-CP 分片索引前缀（按需加载）
  OSS_LIBRARY_PREFIX: "library/",
  OSS_UPLOAD_PREFIX: "uploads/",
  OSS_ARTICLE_PREFIX: "articles/",
  OSS_STYLE_GUIDE: "style-guide.md",
  OSS_PROGRESS: "progress.json",
};

const CP_LIST = ["德哈", "哈德", "德赫", "斯赫", "格邓", "伏哈", "小龙", "柿饼", "待分类"];

function loadUserConfig() {
  try {
    const saved = localStorage.getItem("fanst_user_config");
    if (saved) {
      const user = JSON.parse(saved);
      // 防污染：自动填充可能把 Key 填到 MODEL 字段等
      if (user.READ_MODEL && user.READ_MODEL.startsWith("LTAI")) user.READ_MODEL = CONFIG.READ_MODEL;
      if (user.WRITE_MODEL && user.WRITE_MODEL.startsWith("LTAI")) user.WRITE_MODEL = CONFIG.WRITE_MODEL;
      if (user.BASE_URL && user.BASE_URL.length > 100) user.BASE_URL = CONFIG.BASE_URL;
      Object.assign(CONFIG, user);
    }
  } catch (e) {
    console.error("加载配置失败", e);
  }
}

function saveUserConfig() {
  const toSave = {
    API_KEY: CONFIG.API_KEY,
    READ_MODEL: CONFIG.READ_MODEL,
    WRITE_MODEL: CONFIG.WRITE_MODEL,
    BASE_URL: CONFIG.BASE_URL,
    OSS_KEY_ID: CONFIG.OSS_KEY_ID,
    OSS_KEY_SECRET: CONFIG.OSS_KEY_SECRET,
    OSS_ENDPOINT: CONFIG.OSS_ENDPOINT,
    OSS_BUCKET: CONFIG.OSS_BUCKET,
  };
  localStorage.setItem("fanst_user_config", JSON.stringify(toSave));
}

loadUserConfig();

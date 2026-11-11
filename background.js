// 本地内存缓存，避免重复查询相同短语
const memoryCache = new Map();

// 常见不规则动词还原表
const IRREGULAR_VERBS = {
  brought: "bring", took: "take", taken: "take", made: "make",
  went: "go", gone: "go", came: "come", saw: "see", seen: "see",
  got: "get", gotten: "get", gave: "give", given: "give",
  found: "find", thought: "think", told: "tell", became: "become",
  left: "leave", felt: "feel", put: "put", held: "hold",
  kept: "keep", let: "let", begun: "begin", began: "begin",
  ran: "run", set: "set", stood: "stand", led: "lead",
  paid: "pay", met: "meet", said: "say", laid: "lay",
  sought: "seek", bought: "buy", caught: "catch", taught: "teach",
  fought: "fight", threw: "throw", thrown: "throw", grew: "grow",
  grown: "grow", drew: "draw", drawn: "draw", fell: "fall",
  fallen: "fall", built: "build", sent: "send", spent: "spend",
  cut: "cut", hit: "hit", shut: "shut", spread: "spread",
  struck: "strike", wound: "wind", bound: "bind", bore: "bear",
  borne: "bear", tore: "tear", torn: "tear", wore: "wear",
  worn: "wear", swore: "swear", sworn: "swear", shook: "shake",
  shaken: "shake", drove: "drive", driven: "drive", rode: "ride",
  ridden: "ride", rose: "rise", risen: "rise", wrote: "write",
  written: "write", broke: "break", broken: "break", spoke: "speak",
  spoken: "speak", chose: "choose", chosen: "choose"
};

function deinflectFirstWord(word) {
  const w = word.toLowerCase();
  const candidates = new Set([w]);
  if (IRREGULAR_VERBS[w]) candidates.add(IRREGULAR_VERBS[w]);

  if (w.endsWith("ing") && w.length > 4) {
    const stem = w.slice(0, -3);
    candidates.add(stem);
    candidates.add(stem + "e");
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
      candidates.add(stem.slice(0, -1));
    }
  }
  if (w.endsWith("ied") && w.length > 4) {
    candidates.add(w.slice(0, -3) + "y");
  } else if (w.endsWith("ed") && w.length > 3) {
    const stem = w.slice(0, -2);
    candidates.add(stem);
    candidates.add(w.slice(0, -1));
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) {
      candidates.add(stem.slice(0, -1));
    }
  }
  if (w.endsWith("ies") && w.length > 4) {
    candidates.add(w.slice(0, -3) + "y");
  } else if (w.endsWith("es") && w.length > 3) {
    candidates.add(w.slice(0, -2));
    candidates.add(w.slice(0, -1));
  } else if (w.endsWith("s") && w.length > 2) {
    candidates.add(w.slice(0, -1));
  }
  return Array.from(candidates);
}

function buildSearchCandidates(rawQuery) {
  const clean = rawQuery.trim().replace(/\s+/g, " ");
  const words = clean.split(" ");
  const list = [clean];

  if (words.length >= 2) {
    const firstForms = deinflectFirstWord(words[0]);
    for (const f of firstForms) {
      const candidate = [f, ...words.slice(1)].join(" ");
      if (!list.includes(candidate)) list.push(candidate);
    }
  }

  // 3 词短语自动回退（如 all but certain -> all but）
  if (words.length >= 3) {
    const firstTwo = words.slice(0, 2).join(" ");
    if (!list.includes(firstTwo)) list.push(firstTwo);
  }
  return list.slice(0, 2); // 限制最多2个核心候选，杜绝排队延迟
}

// 1. 超轻量级快速 Fetch（耗时通常 < 800ms，只拉 HTML 字符，不加载广告/图片）
async function quickFetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500); // 2.5秒超时断开
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.status === 200) {
      const html = await res.text();
      const hit = html.includes("def-block") || html.includes("ddef_block") || html.includes("phrase-block");
      if (hit) {
        return { html, finalUrl: res.url, hit: true };
      }
    }
  } catch (e) {
    clearTimeout(timer);
  }
  return { html: "", finalUrl: url, hit: false };
}

// 2. 闪电探测后台标签页（绝不傻等 complete，释义节点一出现立刻秒关标签页）
async function fastTabProbe(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ html: "", finalUrl: url, hit: false });
        return;
      }
      const tabId = tab.id;
      let finished = false;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearInterval(probeInterval);
        clearTimeout(hardTimeout);
        chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; });
        resolve(result);
      };

      // 强制 4 秒上限兜底，防止挂起
      const hardTimeout = setTimeout(() => {
        finish({ html: "", finalUrl: url, hit: false });
      }, 4000);

      // 每 90 毫秒高频探测一次 DOM 是否生成，生成就立刻交卷秒关
      const probeInterval = setInterval(() => {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: () => {
              const hasContent = document.querySelector(".def-block, .ddef_block, .phrase-block, .pr.dictionary");
              const isNotFound = document.body && (
                document.body.innerText.includes("did not match any") ||
                document.body.innerText.includes("未找到符合条件的结果")
              );
              if (hasContent || isNotFound) {
                return {
                  html: document.documentElement.outerHTML,
                  finalUrl: window.location.href,
                  hit: !!hasContent
                };
              }
              return null;
            }
          },
          (results) => {
            if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) return;
            finish(results[0].result);
          }
        );
      }, 90);
    });
  });
}

// 组合调度策略：优先直取 Slug -> 再取快速 Fetch -> 最后才上闪电探测
async function fetchCambridgeFast(query) {
  const slug = query.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
  const directUrl = `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${slug}`;
  const searchUrl = `https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q=${encodeURIComponent(query.trim())}`;

  // 1. 尝试直接请求词条 Slug（耗时通常 < 600ms）
  let directRes = await quickFetchHtml(directUrl);
  if (directRes.hit) return directRes;

  // 2. 尝试快速搜索 URL
  let searchRes = await quickFetchHtml(searchUrl);
  if (searchRes.hit) return searchRes;

  // 3. 若均被拦截，启动毫秒级静默标签页探测
  let tabRes = await fastTabProbe(directUrl);
  if (tabRes.hit) return tabRes;

  return await fastTabProbe(searchUrl);
}

async function invokeAnki(action, params = {}) {
  const res = await fetch("http://127.0.0.1:8765", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params })
  });
  return await res.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "LOOKUP_CAMBRIDGE") {
    (async () => {
      try {
        const queryKey = msg.query.trim().toLowerCase();
        // 命中内存缓存直接 0 秒返回
        if (memoryCache.has(queryKey)) {
          sendResponse({ ok: true, pages: memoryCache.get(queryKey), candidates: [queryKey] });
          return;
        }

        const candidates = buildSearchCandidates(msg.query);
        const pages = [];

        for (const cand of candidates) {
          const res = await fetchCambridgeFast(cand);
          if (res.hit) {
            pages.push({ cand, html: res.html, finalUrl: res.finalUrl });
            break;
          }
        }

        if (pages.length > 0) {
          memoryCache.set(queryKey, pages);
        }
        sendResponse({ ok: true, pages, candidates });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "ANKI_INFO") {
    (async () => {
      try {
        const [decksRes, modelsRes] = await Promise.all([
          invokeAnki("deckNames"),
          invokeAnki("modelNames")
        ]);
        sendResponse({
          ok: true,
          decks: decksRes.result || [],
          models: modelsRes.result || []
        });
      } catch (err) {
        sendResponse({ ok: false, error: "无法连接 Anki" });
      }
    })();
    return true;
  }

  if (msg.type === "ANKI_ADD_NOTE") {
    (async () => {
      try {
        const { deckName, modelName, word, definition, sentence, pageUrl, audioUrl } = msg.payload;
        const finalAudioUrl = audioUrl || `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`;
        const cleanFileName = `cambridge_${word.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}.mp3`;

        const note = {
          deckName,
          modelName,
          fields: {
            "单词": word,
            "释义": definition,
            "例句": sentence,
            "url": pageUrl
          },
          options: { allowDuplicate: true },
          tags: ["Economist_Phrase"],
          audio: [{ url: finalAudioUrl, filename: cleanFileName, fields: ["发音"] }]
        };

        const res = await invokeAnki("addNote", { note });
        if (res.error) {
          sendResponse({ ok: false, error: res.error });
        } else {
          sendResponse({ ok: true, noteId: res.result });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});
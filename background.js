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
  } else if (words.length === 1) {
    for (const f of deinflectFirstWord(words[0])) {
      if (!list.includes(f)) list.push(f);
    }
  }

  if (words.length >= 3) {
    const firstTwo = words.slice(0, 2).join(" ");
    if (!list.includes(firstTwo)) list.push(firstTwo);
    const lastTwo = words.slice(-2).join(" ");
    if (!list.includes(lastTwo)) list.push(lastTwo);
  }
  return list.slice(0, 3);
}

// 核心修复：后台标签页注入“轮询检查”，确保剑桥的释义节点彻底渲染完成后再返回
async function fetchViaBackgroundTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ html: "", finalUrl: url, hit: false });
        return;
      }
      const tabId = tab.id;
      let resolved = false;

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; });
        resolve(result);
      };

      // 8秒超时兜底
      const timeout = setTimeout(() => {
        console.warn("[Cambridge] 页面抓取超时:", url);
        finish({ html: "", finalUrl: url, hit: false });
      }, 8000);

      // 在标签页内部持续轮询等待真实释义节点生成（最多等 4 秒）
      const checkScript = `
        new Promise((res) => {
          let count = 0;
          const interval = setInterval(() => {
            count++;
            const hasContent = document.querySelector(".def-block, .ddef_block, .phrase-block, .pr.dictionary");
            const isNotFound = document.body && document.body.innerText.includes("did not match any document");
            if (hasContent || isNotFound || count > 20) {
              clearInterval(interval);
              res({
                html: document.documentElement.outerHTML,
                finalUrl: window.location.href,
                hit: !!hasContent
              });
            }
          }, 200);
        });
      `;

      // 监听网页初步加载完成，然后启动内部探测
      const onUpdatedHandler = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
          chrome.scripting.executeScript(
            {
              target: { tabId },
              func: () => {
                return new Promise((res) => {
                  let count = 0;
                  const interval = setInterval(() => {
                    count++;
                    const hasContent = document.querySelector(".def-block, .ddef_block, .phrase-block, .pr.dictionary");
                    const isNotFound = document.body && (
                      document.body.innerText.includes("did not match any") ||
                      document.body.innerText.includes("未找到符合条件的结果")
                    );
                    if (hasContent || isNotFound || count > 20) {
                      clearInterval(interval);
                      res({
                        html: document.documentElement.outerHTML,
                        finalUrl: window.location.href,
                        hit: !!hasContent
                      });
                    }
                  }, 150);
                });
              }
            },
            (results) => {
              clearTimeout(timeout);
              if (results && results[0] && results[0].result) {
                console.log("[Cambridge] 页面抓取成功:", results[0].result.finalUrl, "命中状态:", results[0].result.hit);
                finish(results[0].result);
              } else {
                finish({ html: "", finalUrl: url, hit: false });
              }
            }
          );
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdatedHandler);
    });
  });
}

async function fetchCambridgeHtml(query) {
  // 构造两种 URL：一种是直达词条页（最快最稳），一种是搜索页
  const slug = query.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
  const directUrl = `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${slug}`;
  const searchUrl = `https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q=${encodeURIComponent(query.trim())}`;

  // 1. 尝试静默 fetch 直达页（命中就省去开标签页的时间）
  try {
    const res = await fetch(directUrl, { credentials: "include" });
    if (res.status === 200) {
      const html = await res.text();
      if (html.includes("def-block") || html.includes("ddef_block") || html.includes("phrase-block")) {
        console.log("[Cambridge] Fetch 直连命中:", directUrl);
        return { html, finalUrl: res.url, hit: true };
      }
    }
  } catch (e) {}

  // 2. Fetch 没命中或被拦截，使用防抢跑后台真实标签页抓取
  console.log("[Cambridge] 启动后台标签页渲染抓取:", directUrl);
  let resTab = await fetchViaBackgroundTab(directUrl);
  if (resTab.hit) return resTab;

  console.log("[Cambridge] 直达未中，转入搜索页抓取:", searchUrl);
  return await fetchViaBackgroundTab(searchUrl);
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
        console.log("[Cambridge] 收到查询请求:", msg.query);
        const candidates = buildSearchCandidates(msg.query);
        const pages = [];

        for (const cand of candidates) {
          const res = await fetchCambridgeHtml(cand);
          if (res.hit) {
            pages.push({ cand, html: res.html, finalUrl: res.finalUrl });
            break;
          }
        }
        sendResponse({ ok: true, pages, candidates });
      } catch (err) {
        console.error("[Cambridge] 发生全局错误:", err);
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
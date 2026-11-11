(() => {
  let popupHost = null;
  let shadowRoot = null;
  let lastMouseX = window.innerWidth / 2;
  let lastMouseY = window.innerHeight / 3;

  document.addEventListener("mousemove", (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true });

  function extractSentenceWithBold(selection, queryText) {
    if (!selection || selection.rangeCount === 0) return `<b>${queryText}</b>`;
    const range = selection.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) {
      container = container.parentElement;
    }
    while (
      container &&
      container.parentElement &&
      ["SPAN", "B", "I", "EM", "STRONG", "A", "FONT", "MARK"].includes(container.tagName)
    ) {
      container = container.parentElement;
    }

    const fullText = (container ? container.innerText : selection.toString()).replace(/\s+/g, " ").trim();
    const sentences = fullText.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [fullText];
    let targetSentence = fullText;
    for (const s of sentences) {
      if (s.toLowerCase().includes(queryText.toLowerCase())) {
        targetSentence = s.trim();
        break;
      }
    }

    const escaped = queryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return targetSentence.replace(new RegExp(`(${escaped})`, "i"), "<b>$1</b>");
  }

  function parseCambridgePages(rawQuery, pages) {
    const parser = new DOMParser();
    const results = [];
    let ukPron = "";
    let usPron = "";
    let audioUrl = "";
    let matchedHeadword = rawQuery.trim();

    const cleanNorm = (str) =>
      str.toLowerCase()
        .replace(/\b(sb|sth|someone|something|one's|oneself)\b/g, "")
        .replace(/[^a-z\s-]/g, "")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const rawNorm = cleanNorm(rawQuery);

    for (const page of pages) {
      const doc = parser.parseFromString(page.html, "text/html");
      const candNorm = cleanNorm(page.cand);

      if (!ukPron) {
        const ukEl = doc.querySelector(".uk.dpron-i .pron.dpron");
        if (ukEl) ukPron = ukEl.textContent.trim();
      }
      if (!usPron) {
        const usEl = doc.querySelector(".us.dpron-i .pron.dpron");
        if (usEl) usPron = usEl.textContent.trim();
      }
      if (!audioUrl) {
        const usAudio = doc.querySelector(".us.dpron-i source[type='audio/mpeg']");
        const ukAudio = doc.querySelector(".uk.dpron-i source[type='audio/mpeg']");
        const src = (usAudio || ukAudio)?.getAttribute("src");
        if (src) {
          audioUrl = src.startsWith("http") ? src : `https://dictionary.cambridge.org${src}`;
        }
      }

      // 1. 短语块 (.phrase-block / .pv-block / .idiom-block)
      const phraseBlocks = doc.querySelectorAll(".phrase-block, .dphrase-block, .pv-block, .idiom-block");
      for (const pBlock of phraseBlocks) {
        const titleEl = pBlock.querySelector(".phrase-title, .dphrase-title, .di-title, .hw.dhw");
        if (!titleEl) continue;
        const blockTitle = titleEl.textContent.trim();
        const blockNorm = cleanNorm(blockTitle);

        const isMatch =
          blockNorm.includes(rawNorm) ||
          rawNorm.includes(blockNorm) ||
          blockNorm.includes(candNorm) ||
          candNorm.includes(blockNorm);

        if (isMatch) {
          const posEl = pBlock.querySelector(".pos.dpos, .gram.dgram");
          const pos = posEl ? posEl.textContent.trim() : "phrase";
          const defBlocks = pBlock.querySelectorAll(".def-block, .ddef_block");

          defBlocks.forEach((dBlock) => {
            const engEl = dBlock.querySelector(".def.ddef_d");
            const chnEl = dBlock.querySelector(".def-body.ddef_b > .trans.dtrans, .trans.dtrans");
            if (!engEl) return;
            const eng = engEl.textContent.replace(/\s+/g, " ").replace(/:\s*$/, "").trim();
            const chn = chnEl ? chnEl.textContent.replace(/\s+/g, " ").trim() : "";
            results.push({
              headword: blockTitle,
              pos,
              eng,
              chn,
              priority: 1
            });
          });
        }
      }

      // 2. 独立词条主体 (.entry-body__el / .pr.dictionary)
      const entryEls = doc.querySelectorAll(".entry-body__el, .pr.dictionary");
      for (const entry of entryEls) {
        const hwEl = entry.querySelector(".di-title, .hw.dhw");
        const entryTitle = hwEl ? hwEl.textContent.trim() : page.cand;
        const entryNorm = cleanNorm(entryTitle);

        const posEl = entry.querySelector(".pos.dpos");
        const pos = posEl ? posEl.textContent.trim() : "";
        const defBlocks = entry.querySelectorAll(".def-block, .ddef_block");

        defBlocks.forEach((dBlock) => {
          if (dBlock.closest(".phrase-block, .dphrase-block") && results.some((r) => r.priority === 1)) {
            return;
          }
          const engEl = dBlock.querySelector(".def.ddef_d");
          const chnEl = dBlock.querySelector(".def-body.ddef_b > .trans.dtrans, .trans.dtrans");
          if (!engEl) return;
          const eng = engEl.textContent.replace(/\s+/g, " ").replace(/:\s*$/, "").trim();
          const chn = chnEl ? chnEl.textContent.replace(/\s+/g, " ").trim() : "";
          const exactMatch = entryNorm === rawNorm || entryNorm === candNorm || entryNorm.includes(" ");
          results.push({
            headword: entryTitle,
            pos,
            eng,
            chn,
            priority: exactMatch ? 1 : 2
          });
        });
      }

      if (results.some((r) => r.priority === 1)) {
        matchedHeadword = results.find((r) => r.priority === 1).headword;
        break;
      }
    }

    const unique = [];
    const seen = new Set();
    results
      .sort((a, b) => a.priority - b.priority)
      .forEach((item) => {
        const key = `${item.headword}|${item.eng}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(item);
        }
      });

    return {
      headword: matchedHeadword,
      ukPron,
      usPron,
      audioUrl,
      definitions: unique.slice(0, 12)
    };
  }

  function ensurePopup() {
    if (popupHost) return;
    popupHost = document.createElement("div");
    popupHost.id = "cambridge-phrase-helper-host";
    popupHost.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 20px; left: 20px; display: none;";
    document.documentElement.appendChild(popupHost);
    shadowRoot = popupHost.attachShadow({ mode: "open" });

    shadowRoot.innerHTML = `
      <style>
        .card {
          width: 440px;
          max-height: 480px;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          border: 1px solid #d0d7de;
          border-radius: 8px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.18);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
          font-size: 14px;
          color: #24292f;
          overflow: hidden;
        }
        .header {
          padding: 10px 14px;
          background: #f6f8fa;
          border-bottom: 2px solid #57606a;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .word-input {
          font-size: 18px;
          font-weight: 700;
          color: #1f2328;
          border: 1px solid transparent;
          background: transparent;
          padding: 2px 4px;
          border-radius: 4px;
          width: 210px;
        }
        .word-input:focus {
          border-color: #0969da;
          background: #fff;
          outline: none;
        }
        .pron-box {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #57606a;
        }
        .audio-btn {
          cursor: pointer;
          border: none;
          background: #eef1f4;
          border-radius: 4px;
          padding: 3px 6px;
          font-size: 12px;
        }
        .audio-btn:hover { background: #dce2e8; }
        .close-btn {
          cursor: pointer;
          border: none;
          background: transparent;
          font-size: 18px;
          color: #57606a;
          line-height: 1;
        }
        .config-bar {
          padding: 5px 14px;
          background: #f0f4f8;
          border-bottom: 1px solid #e1e4e8;
          display: flex;
          gap: 6px;
          font-size: 11px;
          color: #57606a;
        }
        .config-bar select {
          flex: 1;
          max-width: 195px;
          font-size: 11px;
          padding: 2px;
          border: 1px solid #d0d7de;
          border-radius: 4px;
          background: #fff;
        }
        .def-list {
          padding: 10px 14px;
          overflow-y: auto;
          max-height: 235px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .def-item {
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          padding: 8px 10px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
          background: #fafbfc;
        }
        .def-item:hover { border-color: #b6c2cf; background: #fff; }
        .def-content { flex: 1; line-height: 1.45; }
        .phrase-tag {
          font-weight: 700;
          color: #0969da;
          margin-right: 6px;
        }
        .pos-tag {
          font-style: italic;
          color: #6e7781;
          font-size: 12px;
          margin-right: 6px;
        }
        .eng-def { color: #1f2328; }
        .chn-def {
          display: block;
          color: #0a58ca;
          font-weight: 500;
          margin-top: 3px;
        }
        .add-btn {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          border: none;
          background: #2da44e;
          color: white;
          font-weight: bold;
          font-size: 16px;
          line-height: 22px;
          text-align: center;
          cursor: pointer;
          flex-shrink: 0;
          margin-top: 2px;
        }
        .add-btn:hover { background: #218838; }
        .add-btn.added { background: #6e7781; cursor: default; }
        .sentence-box {
          padding: 10px 14px;
          border-top: 1px dashed #d0d7de;
          background: #f8f9fa;
        }
        .sentence-label {
          font-size: 11px;
          color: #57606a;
          margin-bottom: 4px;
        }
        .sentence-editor {
          border: 1px solid #d0d7de;
          background: #fff;
          border-radius: 4px;
          padding: 6px 8px;
          font-size: 13px;
          line-height: 1.45;
          max-height: 85px;
          overflow-y: auto;
          outline: none;
        }
        .status-msg {
          padding: 16px;
          text-align: center;
          color: #57606a;
          line-height: 1.5;
        }
      </style>
      <div class="card">
        <div class="header">
          <input class="word-input" id="headwordInput" title="点击可手动微调制卡词头" />
          <div class="pron-box">
            <span id="pronText"></span>
            <button class="audio-btn" id="playAudioBtn" title="播放发音">🔊</button>
          </div>
          <button class="close-btn" id="closeBtn" title="关闭">×</button>
        </div>
        <div class="config-bar">
          <select id="deckSelect" title="Anki 牌组"></select>
          <select id="modelSelect" title="Anki 模板"></select>
        </div>
        <div class="def-list" id="defList"></div>
        <div class="sentence-box">
          <div class="sentence-label">原句笔记（可直接编辑修改）：</div>
          <div class="sentence-editor" id="sentenceEditor" contenteditable="true"></div>
        </div>
      </div>
    `;

    shadowRoot.getElementById("closeBtn").addEventListener("click", () => {
      popupHost.style.display = "none";
    });
  }

  document.addEventListener("mousedown", (e) => {
    if (popupHost && popupHost.style.display === "block") {
      if (!e.composedPath().includes(popupHost)) {
        popupHost.style.display = "none";
      }
    }
  });

  async function loadAnkiSelectors() {
    const deckSelect = shadowRoot.getElementById("deckSelect");
    const modelSelect = shadowRoot.getElementById("modelSelect");
    if (deckSelect.options.length > 0) return;

    try {
      chrome.runtime.sendMessage({ type: "ANKI_INFO" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          deckSelect.innerHTML = `<option>未连接 AnkiConnect</option>`;
          return;
        }
        chrome.storage.local.get(["savedDeck", "savedModel"], (stored) => {
          const defaultDeck =
            stored.savedDeck ||
            res.decks.find((d) => d.startsWith(",,,,,,,,,,,,,,000Magazines::E")) ||
            res.decks.find((d) => d.includes("000Magazines")) ||
            res.decks[0];

          const defaultModel =
            stored.savedModel ||
            res.models.find((m) => m.startsWith("划词助手Antimoon模板 默认")) ||
            res.models.find((m) => m.startsWith("划词助手Antimoon模板")) ||
            res.models[0];

          deckSelect.innerHTML = res.decks
            .map((d) => `<option value="${d}" ${d === defaultDeck ? "selected" : ""}>${d}</option>`)
            .join("");
          modelSelect.innerHTML = res.models
            .map((m) => `<option value="${m}" ${m === defaultModel ? "selected" : ""}>${m}</option>`)
            .join("");

          deckSelect.onchange = () => chrome.storage.local.set({ savedDeck: deckSelect.value });
          modelSelect.onchange = () => chrome.storage.local.set({ savedModel: modelSelect.value });
        });
      });
    } catch (e) {}
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Alt" || e.ctrlKey || e.shiftKey || e.metaKey) return;
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString().trim() : "";
    if (!selectedText) return;

    e.preventDefault();

    ensurePopup();
    loadAnkiSelectors();

    const sentenceHtml = extractSentenceWithBold(sel, selectedText);
    const headwordInput = shadowRoot.getElementById("headwordInput");
    const pronText = shadowRoot.getElementById("pronText");
    const defList = shadowRoot.getElementById("defList");
    const sentenceEditor = shadowRoot.getElementById("sentenceEditor");
    const playAudioBtn = shadowRoot.getElementById("playAudioBtn");

    headwordInput.value = selectedText;
    pronText.textContent = "查询剑桥词典中...";
    defList.innerHTML = `<div class="status-msg">正在从 Cambridge Online 获取双解释义...</div>`;
    sentenceEditor.innerHTML = sentenceHtml;

    const x = Math.min(Math.max(15, lastMouseX - 100), window.innerWidth - 460);
    const y = Math.min(Math.max(15, lastMouseY + 20), window.innerHeight - 490);
    popupHost.style.left = `${x}px`;
    popupHost.style.top = `${y}px`;
    popupHost.style.display = "block";

    try {
      chrome.runtime.sendMessage({ type: "LOOKUP_CAMBRIDGE", query: selectedText }, (res) => {
        if (chrome.runtime.lastError) {
          pronText.textContent = "";
          defList.innerHTML = `<div class="status-msg">插件刚刚更新，请按 <b>F5 刷新当前网页</b> 后再试！</div>`;
          return;
        }
        if (!res || !res.ok) {
          pronText.textContent = "";
          defList.innerHTML = `<div class="status-msg">查询出错：${res?.error || "未知网络错误"}</div>`;
          return;
        }
        if (res.blockedByCloudflare && (!res.pages || res.pages.length === 0)) {
          pronText.textContent = "";
          defList.innerHTML = `<div class="status-msg">请求被拦截，请在浏览器新标签页访问一次 <a href="https://dictionary.cambridge.org" target="_blank">dictionary.cambridge.org</a></div>`;
          return;
        }
        if (!res.pages || res.pages.length === 0) {
          pronText.textContent = "";
          defList.innerHTML = `<div class="status-msg">未在剑桥词典中找到 "${selectedText}" 的对应词条。</div>`;
          return;
        }

        const parsed = parseCambridgePages(selectedText, res.pages);
        headwordInput.value = parsed.headword || selectedText;
        pronText.textContent = parsed.usPron ? `美 ${parsed.usPron}` : parsed.ukPron ? `英 ${parsed.ukPron}` : "";

        const currentAudioUrl =
          parsed.audioUrl || `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(headwordInput.value)}&type=2`;
        playAudioBtn.onclick = () => {
          new Audio(currentAudioUrl).play();
        };

        if (parsed.definitions.length === 0) {
          defList.innerHTML = `<div class="status-msg">未提取到具体分项释义，请尝试只划选短语的核心部分。</div>`;
          return;
        }

        defList.innerHTML = "";
        parsed.definitions.forEach((item) => {
          const row = document.createElement("div");
          row.className = "def-item";
          row.innerHTML = `
            <div class="def-content">
              <span class="phrase-tag">${item.headword}</span>
              ${item.pos ? `<span class="pos-tag">${item.pos}</span>` : ""}
              <span class="eng-def">${item.eng}</span>
              ${item.chn ? `<span class="chn-def">${item.chn}</span>` : ""}
            </div>
            <button class="add-btn" title="导入此条释义到 Anki">+</button>
          `;

          const addBtn = row.querySelector(".add-btn");
          addBtn.addEventListener("click", () => {
            if (addBtn.classList.contains("added")) return;
            const deckName = shadowRoot.getElementById("deckSelect").value;
            const modelName = shadowRoot.getElementById("modelSelect").value;

            // 纯净语义标签输出：完全交由 Anki 模板 CSS 控制，不剧透词头
            const posHtml = item.pos ? `<span class="phrase-pos">[${item.pos}]</span> ` : "";
            const chnHtml = item.chn ? `<div class="phrase-chn">${item.chn}</div>` : "";
            const formattedDef = `<div class="cambridge-def">${posHtml}<span class="phrase-eng">${item.eng}</span>${chnHtml}</div>`.trim();

            addBtn.textContent = "…";
            chrome.runtime.sendMessage(
              {
                type: "ANKI_ADD_NOTE",
                payload: {
                  deckName,
                  modelName,
                  word: headwordInput.value.trim(),
                  definition: formattedDef,
                  sentence: sentenceEditor.innerHTML,
                  pageUrl: window.location.href,
                  audioUrl: parsed.audioUrl
                }
              },
              (ankiRes) => {
                if (ankiRes && ankiRes.ok) {
                  addBtn.textContent = "✓";
                  addBtn.classList.add("added");
                } else {
                  addBtn.textContent = "!";
                  alert("制卡失败：" + (ankiRes?.error || "请检查 Anki 是否打开"));
                }
              }
            );
          });

          defList.appendChild(row);
        });
      });
    } catch (err) {
      pronText.textContent = "";
      defList.innerHTML = `<div class="status-msg">插件刚刚更新，请按 <b>F5 刷新当前网页</b> 后再试！</div>`;
    }
  });
})();
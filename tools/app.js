(function () {
  "use strict";

  // =====================================================================
  // TIỆN ÍCH
  // =====================================================================
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "info");
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .2s, transform .2s";
      el.style.opacity = "0";
      el.style.transform = "translateY(4px)";
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  // =====================================================================
  // PARSER SQL (không phụ thuộc DOM — có thể test riêng)
  // =====================================================================
  function stripSqlComments(src) {
    // Bỏ block comment /* */ và line comment --, giữ lại ký tự xuống dòng
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n\r]*/g, "");
  }

  // Bỏ [] hoặc "" bao quanh, lấy phần sau dấu chấm cuối ([dbo].[Product] -> Product)
  function normalizeName(raw) {
    const parts = String(raw).trim().split(".");
    let name = parts[parts.length - 1].trim();
    name = name.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "");
    return name;
  }

  // Tìm vị trí dấu ')' khớp với '(' tại openIndex (bỏ qua chuỗi và [..])
  function findMatchingParen(str, openIndex) {
    let depth = 0;
    let inString = false;
    let inBracket = false;
    for (let i = openIndex; i < str.length; i++) {
      const ch = str[i];
      if (inString) {
        if (ch === "'") {
          if (str[i + 1] === "'") i++; // '' escape
          else inString = false;
        }
        continue;
      }
      if (inBracket) {
        if (ch === "]") inBracket = false;
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === "[") inBracket = true;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Tách định nghĩa column/constraint theo dấu phẩy ở cấp ngoài cùng
  function splitDefinitions(body) {
    const parts = [];
    let buf = "";
    let depth = 0;
    let inString = false;
    let inBracket = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inString) {
        buf += ch;
        if (ch === "'") {
          if (body[i + 1] === "'") { buf += body[++i]; }
          else inString = false;
        }
        continue;
      }
      if (inBracket) {
        buf += ch;
        if (ch === "]") inBracket = false;
        continue;
      }
      if (ch === "'") { inString = true; buf += ch; continue; }
      if (ch === "[") { inBracket = true; buf += ch; continue; }
      if (ch === "(") { depth++; buf += ch; continue; }
      if (ch === ")") { depth--; buf += ch; continue; }
      if (ch === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
  }

  function splitColumnList(raw) {
    return raw.split(",").map((s) => normalizeName(s.trim())).filter(Boolean);
  }

  // Lấy biểu thức sau DEFAULT (dừng ở keyword kế tiếp)
  function readDefault(rest) {
    const idx = rest.search(/\bdefault\b/i);
    if (idx < 0) return null;
    let tail = rest.slice(idx + "default".length).trim();
    const stop = tail.search(
      /\b(not\s+null|null|primary\s+key|references|unique|check|constraint|collate|identity|sparse|persisted|with\s+values)\b/i
    );
    if (stop >= 0) tail = tail.slice(0, stop);
    tail = tail.trim().replace(/,$/, "");
    return tail || null;
  }

  // Lấy biểu thức trong CHECK (...) đầu tiên
  function readCheck(rest) {
    const m = /\bcheck\s*\(/i.exec(rest);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const close = findMatchingParen(rest, open);
    if (close < 0) return null;
    return rest.slice(open + 1, close).trim() || null;
  }

  function applyConstraints(tables, constraints) {
    const tableByName = (name) =>
      tables.find((t) => t.name.toLowerCase() === name.toLowerCase());

    constraints.forEach((c) => {
      const table = tableByName(c.table);
      if (!table) return;

      if (c.type === "pk") {
        table.columns.forEach((col) => {
          if (c.columns.some((n) => n.toLowerCase() === col.name.toLowerCase())) {
            col.pk = true;
            col.nullable = false;
          }
        });
        return;
      }

      if (c.type === "fk") {
        c.columns.forEach((colName, i) => {
          const col = table.columns.find((x) => x.name.toLowerCase() === colName.toLowerCase());
          if (col) {
            col.fk = {
              table: c.refTable,
              column: c.refColumns[i] || c.refColumns[0]
            };
          }
        });
        return;
      }

      if (c.type === "unique") {
        table.uniques.push(c.columns);
        return;
      }

      if (c.type === "check") {
        table.checks.push({ column: c.column || null, expr: c.expr });
        return;
      }

      if (c.type === "default") {
        const col = table.columns.find(
          (x) => x.name.toLowerCase() === String(c.column || "").toLowerCase()
        );
        if (col) col.defaultValue = c.expr;
      }
    });
  }

  function parseSql(sqlText) {
    const sql = stripSqlComments(sqlText || "");
    const tables = [];
    const constraints = []; // PK/FK/UNIQUE/CHECK/DEFAULT xử lý sau khi biết hết column

    const re = /create\s+table\s+/gi;
    let m;
    while ((m = re.exec(sql))) {
      const start = m.index + m[0].length;
      const openIdx = sql.indexOf("(", start);
      if (openIdx === -1) break;
      const nameRaw = sql.slice(start, openIdx).replace(/if\s+not\s+exists/i, "").trim();
      if (!nameRaw) continue;
      const closeIdx = findMatchingParen(sql, openIdx);
      if (closeIdx === -1) break;
      const body = sql.slice(openIdx + 1, closeIdx);
      re.lastIndex = closeIdx;

      const table = { name: normalizeName(nameRaw), columns: [], checks: [], uniques: [] };
      // Bỏ qua bảng trùng tên
      if (tables.some((t) => t.name.toLowerCase() === table.name.toLowerCase())) continue;

      splitDefinitions(body).forEach((rawDef) => {
        let def = rawDef.trim();
        if (!def) return;

        // Bỏ tên constraint: CONSTRAINT [FK_x] FOREIGN KEY ...
        const cName = def.match(/^constraint\s+(\[[^\]]+\]|"[^"]+"|\S+)\s+/i);
        const cNameValue = cName ? normalizeName(cName[1]) : null;
        if (cName) def = def.slice(cName[0].length).trim();

        // PRIMARY KEY mức bảng
        if (/^primary\s+key\b/i.test(def)) {
          const pm = def.match(/\(([^)]*)\)/);
          if (pm) constraints.push({ table: table.name, type: "pk", columns: splitColumnList(pm[1]) });
          return;
        }

        // FOREIGN KEY mức bảng
        if (/^foreign\s+key\b/i.test(def)) {
          const fm = def.match(/foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i);
          if (fm) {
            constraints.push({
              table: table.name,
              type: "fk",
              columns: splitColumnList(fm[1]),
              refTable: normalizeName(fm[2]),
              refColumns: fm[3] ? splitColumnList(fm[3]) : ["Id"],
              name: cNameValue
            });
          }
          return;
        }

        // UNIQUE mức bảng
        if (/^unique\b/i.test(def)) {
          const um = def.match(/\(([^)]*)\)/);
          if (um) constraints.push({ table: table.name, type: "unique", columns: splitColumnList(um[1]) });
          return;
        }

        // CHECK mức bảng
        if (/^check\b/i.test(def)) {
          const expr = readCheck(def);
          if (expr) constraints.push({ table: table.name, type: "check", expr });
          return;
        }

        // INDEX / KEY / PERIOD: bỏ qua
        if (/^(index|key|period)\b/i.test(def)) return;

        // --- Đây là 1 column ---
        const nameM = def.match(/^(\[[^\]]+\]|"[^"]+"|[\w$#@]+)/);
        if (!nameM) return;
        const colName = normalizeName(nameM[1]);
        const rest = def.slice(nameM[0].length).trim();

        // Column computed: [Total] AS (Price * Qty)
        if (/^as\b/i.test(rest)) {
          table.columns.push({
            name: colName,
            type: "COMPUTED",
            nullable: false,
            pk: false,
            identity: false,
            unique: false,
            fk: null,
            defaultValue: null,
            computed: true,
            computedExpr: rest.replace(/^as\s*/i, "").trim() || null
          });
          return;
        }

        const typeM = rest.match(/^([A-Za-z_][\w]*)\s*(\([^)]*\))?/);
        if (!typeM) return;
        const type = (typeM[1] + (typeM[2] ? typeM[2].replace(/\s+/g, "") : "")).toUpperCase();

        const col = {
          name: colName,
          type: type,
          nullable: !/\bnot\s+null\b/i.test(rest),
          pk: /\bprimary\s+key\b/i.test(rest),
          identity: /\bidentity\b/i.test(rest),
          unique: /\bunique\b/i.test(rest),
          fk: null,
          defaultValue: readDefault(rest),
          computed: false
        };

        const inlineFk = rest.match(/\breferences\s+([^\s(]+)\s*\(\s*([^)]+)\)/i);
        if (inlineFk) {
          col.fk = {
            table: normalizeName(inlineFk[1]),
            column: normalizeName(inlineFk[2].split(",")[0])
          };
        }

        const inlineCheck = readCheck(rest);
        if (inlineCheck) {
          constraints.push({ table: table.name, type: "check", column: col.name, expr: inlineCheck });
        }

        if (col.pk) col.nullable = false;
        table.columns.push(col);
      });

      tables.push(table);
    }

    // ALTER TABLE ... ADD CONSTRAINT ... (script hay dùng)
    const alterRe = /alter\s+table\s+([\w\[\]."]+)\s+add\s+([\s\S]*?)(?=;|\bgo\b|$)/gi;
    let am;
    while ((am = alterRe.exec(sql))) {
      const tableName = normalizeName(am[1]);
      let chunk = am[2].trim();

      // Bỏ tên constraint nếu có
      chunk = chunk.replace(/^constraint\s+(\[[^\]]+\]|"[^"]+"|\S+)\s+/i, "");

      if (/^foreign\s+key\b/i.test(chunk)) {
        const fm = chunk.match(/foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)\s*(?:\(([^)]*)\))?/i);
        if (fm) {
          constraints.push({
            table: tableName,
            type: "fk",
            columns: splitColumnList(fm[1]),
            refTable: normalizeName(fm[2]),
            refColumns: fm[3] ? splitColumnList(fm[3]) : ["Id"]
          });
        }
      } else if (/^primary\s+key\b/i.test(chunk)) {
        const pm = chunk.match(/\(([^)]*)\)/);
        if (pm) constraints.push({ table: tableName, type: "pk", columns: splitColumnList(pm[1]) });
      } else if (/^unique\b/i.test(chunk)) {
        const um = chunk.match(/\(([^)]*)\)/);
        if (um) constraints.push({ table: tableName, type: "unique", columns: splitColumnList(um[1]) });
      } else if (/^check\b/i.test(chunk)) {
        const expr = readCheck(chunk);
        if (expr) constraints.push({ table: tableName, type: "check", expr });
      } else if (/^default\b/i.test(chunk)) {
        const dm = chunk.match(/^default\s+([\s\S]*?)\s+for\s+([\w\[\]"]+)/i);
        if (dm) {
          constraints.push({
            table: tableName,
            type: "default",
            column: normalizeName(dm[2]),
            expr: dm[1].trim()
          });
        }
      }
    }

    // Áp constraint mức bảng vào column
    applyConstraints(tables, constraints);

    // Quan hệ: chỉ giữ FK trỏ tới bảng có trong danh sách
    const relations = [];
    tables.forEach((t) => {
      t.columns.forEach((col) => {
        if (!col.fk) return;
        const target = tables.find((x) => x.name.toLowerCase() === col.fk.table.toLowerCase());
        if (!target) return;
        relations.push({
          from: t.name,
          fromColumn: col.name,
          to: target.name,
          toColumn: col.fk.column
        });
      });
    });

    return { tables, relations };
  }
  // ===== KẾT THÚC PARSER =====

  // =====================================================================
  // TRẠNG THÁI
  // =====================================================================
  const DEFAULT_MESSAGES = {
    notFound: "Không tìm thấy {model}.",
    validation: "Dữ liệu không hợp lệ.",
    mismatch: "Khóa trên URL không khớp với body.",
    unauthorized: "Chưa đăng nhập hoặc token không hợp lệ.",
    forbidden: "Bạn không có quyền truy cập."
  };

  const state = {
    tables: [],
    relations: [],
    ids: new Map(), // tên bảng -> id DOM
    query: "",
    genTable: null,
    genCode: "",
    ctxCode: "",
    razorCode: "",
    razorCs: "",
    loginCode: "",
    loginApiCode: "",
    linqCode: "",
    odataCode: "",
    messages: { ...DEFAULT_MESSAGES },
    customMessages: [] // message thêm tự do qua nút “Thêm message” (status + nội dung)
  };

  // Message tùy chỉnh (thêm mới) — ưu tiên theo cặp (endpoint, status) của từng scenario.
  function customMsg(endpoint, status) {
    const list = state.customMessages.filter(
      (m) => m.endpoint === endpoint && String(m.status) === String(status)
    );
    const found = list[list.length - 1];
    return found && found.text && found.text.trim() ? found : null;
  }

  // =====================================================================
  // RENDER DANH SÁCH BẢNG
  // =====================================================================
  function chip(text, kind) {
    return `<span class="chip${kind ? " chip-" + kind : ""}">${esc(text)}</span>`;
  }

  function keyMarks(col) {
    let out = "";
    if (col.pk) out += `<span class="key key-pk">PK</span>`;
    if (col.fk) out += `<span class="key key-fk">FK</span>`;
    return out;
  }

  function columnConstraintChips(col) {
    const chips = [];
    if (col.identity) chips.push(chip("IDENTITY", "id"));
    if (col.unique) chips.push(chip("UNIQUE", "uniq"));
    if (col.defaultValue) chips.push(chip("DEFAULT " + col.defaultValue, "def"));
    if (col.computed) chips.push(chip("AS " + (col.computedExpr || "..."), "comp"));
    return chips.length ? chips.join("") : `<span class="muted">—</span>`;
  }

  function fkCell(col) {
    if (!col.fk) return `<span class="muted">—</span>`;
    const targetId = state.ids.get(
      (state.tables.find((t) => t.name.toLowerCase() === col.fk.table.toLowerCase()) || {}).name
    );
    const label = `${col.fk.table}.${col.fk.column}`;
    if (!targetId) return `<span class="fk-static">→ ${esc(label)}</span>`;
    return `<button type="button" class="fk-link" data-target="${esc(targetId)}" title="Tới bảng ${esc(col.fk.table)}">→ ${esc(label)}</button>`;
  }

  function checksBlock(table) {
    if (!table.checks.length) return "";
    const items = table.checks
      .map(
        (c) =>
          `<code class="check">${c.column ? esc(c.column) + ": " : ""}${esc(c.expr)}</code>`
      )
      .join("");
    return `<div class="tbl-note"><span class="note-label">CHECK</span><span class="note-items">${items}</span></div>`;
  }

  function uniquesBlock(table) {
    if (!table.uniques.length) return "";
    const items = table.uniques
      .map((cols) => `<code class="check check-uq">UNIQUE (${esc(cols.join(", "))})</code>`)
      .join("");
    return `<div class="tbl-note"><span class="note-label">UNIQUE</span><span class="note-items">${items}</span></div>`;
  }

  function incomingBlock(table) {
    const incoming = state.relations.filter((r) => r.to === table.name);
    if (!incoming.length) return "";
    const items = incoming
      .map((r) => {
        const srcId = state.ids.get(r.from);
        const label = `${r.from}.${r.fromColumn} → ${r.toColumn}`;
        if (!srcId) return `<span class="fk-static">${esc(label)}</span>`;
        return `<button type="button" class="fk-link" data-target="${esc(srcId)}" title="Tới bảng ${esc(r.from)}">${esc(label)}</button>`;
      })
      .join("");
    return `<div class="tbl-note"><span class="note-label">Bị tham chiếu bởi</span><span class="note-items">${items}</span></div>`;
  }

  function renderTable(table, index) {
    const outFk = table.columns.filter((c) => c.fk).length;
    const outRefs = state.relations.filter((r) => r.from === table.name).length;
    const searchText = (
      table.name +
      " " +
      table.columns.map((c) => c.name + " " + c.type).join(" ")
    ).toLowerCase();

    const rows = table.columns
      .map((col) => {
        return `<tr>
          <td class="col-name" data-label="Field">${keyMarks(col)}<code>${esc(col.name)}</code></td>
          <td class="col-type" data-label="Kiểu"><code>${esc(col.type)}</code></td>
          <td class="col-null" data-label="Null">${col.nullable ? `<span class="muted">NULL</span>` : `<span class="not-null">NOT NULL</span>`}</td>
          <td class="col-cons" data-label="Ràng buộc">${columnConstraintChips(col)}</td>
          <td class="col-fk" data-label="Khóa ngoại">${fkCell(col)}</td>
        </tr>`;
      })
      .join("");

    return `<details class="tbl" id="${esc(state.ids.get(table.name))}" data-search="${esc(searchText)}" open>
      <summary class="tbl-head">
        <span class="tbl-index">${index + 1}</span>
        <span class="tbl-name">${esc(table.name)}</span>
        <span class="tbl-badges">
          <span class="badge">${table.columns.length} field</span>
          <span class="badge${outRefs ? " badge-fk" : ""}">${outRefs} FK</span>
          ${table.checks.length ? `<span class="badge badge-ck">${table.checks.length} CHECK</span>` : ""}
        </span>
        <button type="button" class="tbl-action" data-gen="${esc(table.name)}" title="Sinh controller CRUD cho bảng này">Sinh CRUD</button>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </summary>
      <div class="tbl-body">
        <div class="fields-wrap">
          <table class="fields">
            <thead>
              <tr>
                <th>Field</th>
                <th>Kiểu</th>
                <th>Null</th>
                <th>Ràng buộc</th>
                <th>Khóa ngoại</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${checksBlock(table)}
        ${uniquesBlock(table)}
        ${incomingBlock(table)}
      </div>
    </details>`;
  }

  function renderResults() {
    const list = $("#tableList");

    state.ids = new Map(state.tables.map((t, i) => [t.name, "tbl-" + i]));
    list.innerHTML = state.tables.map(renderTable).join("");

    const has = state.tables.length > 0;
    $("#emptyState").hidden = has;
    $("#resultMeta").textContent = has ? `${state.tables.length} bảng` : "Chưa có dữ liệu";
    applyFilter();
    refreshGenOptions();
  }

  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    let visible = 0;

    document.querySelectorAll("#tableList .tbl").forEach((el) => {
      const match = !q || el.getAttribute("data-search").includes(q);
      el.hidden = !match;
      el.classList.toggle("is-match", !!q && match);
      if (match) {
        visible++;
        if (q) el.open = true;
      }
    });

    const noResult = $("#noResult");
    noResult.hidden = !(state.tables.length > 0 && visible === 0);
    if (!noResult.hidden) {
      noResult.textContent = `Không tìm thấy bảng hoặc field nào khớp “${state.query.trim()}”.`;
    }
    $("#resultMeta").textContent = state.tables.length
      ? q
        ? `${visible}/${state.tables.length} bảng khớp`
        : `${state.tables.length} bảng`
      : "Chưa có dữ liệu";
  }

  // =====================================================================
  // HÀNH ĐỘNG
  // =====================================================================
  function updateStats() {
    const tableCount = state.tables.length;
    const colCount = state.tables.reduce((a, t) => a + t.columns.length, 0);
    const fkCount = state.relations.length;
    const checkCount = state.tables.reduce((a, t) => a + t.checks.length, 0);
    $("#stats").textContent = `${tableCount} bảng · ${colCount} field · ${fkCount} FK · ${checkCount} CHECK`;
  }

  function analyze() {
    const sql = $("#sqlInput").value;
    if (!sql.trim()) {
      toast("Chưa có SQL để phân tích.", "err");
      return;
    }

    let result;
    try {
      result = parseSql(sql);
    } catch (err) {
      toast("SQL không hợp lệ: " + err.message, "err");
      return;
    }
    if (!result.tables.length) {
      toast("Không tìm thấy CREATE TABLE nào.", "err");
      return;
    }

    state.tables = result.tables;
    state.relations = result.relations;
    state.query = "";
    $("#searchInput").value = "";

    renderResults();
    updateStats();

    $("#resultScroll").scrollTop = 0;
    if (window.innerWidth <= 980) {
      $(".result-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    $("#status").innerHTML = `<span class="dot"></span>Đã phân tích ${state.tables.length} bảng`;
    toast(`Phân tích xong: ${state.tables.length} bảng, ${state.relations.length} khóa ngoại.`, "ok");
  }

  function clearAll() {
    state.tables = [];
    state.relations = [];
    state.query = "";
    $("#sqlInput").value = "";
    $("#searchInput").value = "";
    $("#fileName").hidden = true;
    $("#fileMeta").textContent = "Chưa có file";
    $("#tableList").innerHTML = "";
    $("#emptyState").hidden = false;
    $("#noResult").hidden = true;
    $("#resultMeta").textContent = "Chưa có dữ liệu";
    $("#status").innerHTML = `<span class="dot"></span>Sẵn sàng`;
    updateStats();
  }

  // Đọc file .sql (chỉ đọc local, không upload)
  function readFile(file) {
    if (!file) return;
    if (!/\.(sql|txt)$/i.test(file.name)) {
      toast("Chỉ hỗ trợ file .sql hoặc .txt", "err");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      $("#sqlInput").value = String(reader.result || "");
      $("#fileName").hidden = false;
      $("#fileName").textContent = file.name;
      $("#fileMeta").textContent = Math.max(1, Math.round(file.size / 1024)) + " KB";
      analyze();
    };
    reader.onerror = () => toast("Không đọc được file.", "err");
    reader.readAsText(file, "utf-8");
  }

  // =====================================================================
  // SINH CONTROLLER CRUD
  // =====================================================================
  function pascal(name) {
    return String(name || "")
      .replace(/[^A-Za-z0-9_]/g, "")
      .replace(/^./, (c) => c.toUpperCase());
  }

  function camel(name) {
    const p = pascal(name);
    return p ? p.charAt(0).toLowerCase() + p.slice(1) : p;
  }

  function pluralize(name) {
    if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + "ies";
    if (/(s|x|z|ch|sh)$/i.test(name)) return name + "es";
    return name + "s";
  }

  function csKeyType(sqlType) {
    const t = String(sqlType || "").toUpperCase();
    if (/^BIGINT/.test(t)) return "long";
    if (/^(INT|SMALLINT|TINYINT)/.test(t)) return "int";
    if (/^UNIQUEIDENTIFIER/.test(t)) return "Guid";
    if (/^(DECIMAL|NUMERIC|MONEY|SMALLMONEY)/.test(t)) return "decimal";
    return "string";
  }

  function csRouteConstraint(sqlType) {
    const t = String(sqlType || "").toUpperCase();
    if (/^(INT|SMALLINT|TINYINT)/.test(t)) return ":int";
    if (/^BIGINT/.test(t)) return ":long";
    if (/^UNIQUEIDENTIFIER/.test(t)) return ":guid";
    return "";
  }

  // Khóa để sinh route/param (fallback cột đầu nếu bảng thiếu PK)
  function genKeys(table) {
    let keys = table.columns.filter((c) => c.pk);
    if (!keys.length) keys = table.columns.slice(0, 1);
    return keys.map((c) => ({
      prop: pascal(c.name),
      param: camel(c.name),
      type: csKeyType(c.type),
      route: csRouteConstraint(c.type)
    }));
  }

  function refreshGenOptions() {
    const sel = $("#genTable");
    if (!sel) return;

    // Bảng đã dán trước đó có thể không nằm trong danh sách phân tích
    const list = state.tables.slice();
    if (state.genTable) {
      const fresh = state.tables.find((t) => t.name === state.genTable.name);
      if (fresh) state.genTable = fresh;
      else if (!list.some((t) => t.name === state.genTable.name)) list.unshift(state.genTable);
    }

    sel.innerHTML = list.length
      ? list
          .map(
            (t) =>
              `<option value="${esc(t.name)}">${esc(t.name)} · ${t.columns.length} field</option>`
          )
          .join("")
      : `<option value="">— chưa có bảng —</option>`;

    if (state.genTable) sel.value = state.genTable.name;
    else if (list.length) sel.value = list[0].name;

    $("#genSourceMeta").textContent = state.genTable
      ? `${state.genTable.name} · ${state.genTable.columns.length} field`
      : "Chưa có bảng";

    // Bảng đổi (hoặc cột đổi) thì vẽ lại danh sách cột search/sort
    if (genFieldSig(state.genTable) !== state.genFieldsFor) renderGenFields(true);
  }

  function setGenTable(table) {
    if (!table) return;
    state.genTable = table;
    $("#genController").value = pluralize(pascal(table.name)) + "Controller";
    refreshGenOptions();
    renderGen();
  }

  // Cột số (sort được) / cột text (search được) — dựa trên kiểu SQL
  function genFieldKind(sqlType) {
    const t = String(sqlType || "").toUpperCase().replace(/\(.*$/, "").trim();
    if (/^(INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|FLOAT|REAL|MONEY|SMALLMONEY)$/.test(t)) return "number";
    if (/^(CHAR|VARCHAR|NCHAR|NVARCHAR|TEXT|NTEXT|SYSNAME)$/.test(t)) return "text";
    if (/^(DATE|DATETIME|DATETIME2|SMALLDATETIME|DATETIMEOFFSET|TIME)$/.test(t)) return "date";
    return "other";
  }

  function genFieldSig(table) {
    return table ? table.name + "|" + table.columns.map((c) => c.name).join(",") : "";
  }

  // Vẽ danh sách cột search/sort theo bảng đang chọn
  function renderGenFields(reset) {
    const table = state.genTable;
    const searchBox = $("#genSearchFields");
    const sortBox = $("#genSortFields");
    if (!searchBox || !sortBox) return;
    if (reset) state.genFieldsFor = table ? genFieldSig(table) : null;

    if (!table) {
      searchBox.innerHTML = `<span class="muted">Chọn bảng trước.</span>`;
      sortBox.innerHTML = `<span class="muted">Chọn bảng trước.</span>`;
      return;
    }

    const texts = table.columns.filter((c) => genFieldKind(c.type) === "text");
    const nums = table.columns.filter((c) => ["number", "text", "date"].includes(genFieldKind(c.type)));

    searchBox.innerHTML = texts.length
      ? texts
          .map(
            (c) =>
              `<label class="check-row"><input type="checkbox" class="gen-search" value="${esc(c.name)}" /><span><code>${esc(c.name)}</code></span></label>`
          )
          .join("")
      : `<span class="muted">Bảng không có cột text để search.</span>`;

    sortBox.innerHTML = nums.length
      ? nums
          .map(
            (c) =>
              `<div class="sort-row">
                <label class="check-row"><input type="checkbox" class="gen-sort" value="${esc(c.name)}" /><span><code>${esc(c.name)}</code></span></label>
                <select class="input mini gen-dir" data-col="${esc(c.name)}" disabled>
                  <option value="asc">Tăng dần</option>
                  <option value="desc">Giảm dần</option>
                </select>
              </div>`
          )
          .join("")
      : `<span class="muted">Bảng không có cột số để sort.</span>`;

    syncGenDisabled();
  }

  // Search/sort chỉ có ý nghĩa khi sinh action list
  function syncGenDisabled() {
    const listOn = document.querySelector('.gen-act[value="list"]');
    const enabled = !listOn || listOn.checked;
    document.querySelectorAll("#genSearchFields .gen-search").forEach((el) => (el.disabled = !enabled));
    document.querySelectorAll("#genSortFields .gen-sort").forEach((el) => (el.disabled = !enabled));
    document.querySelectorAll("#genSortFields .gen-dir").forEach((el) => {
      const cb = el.closest(".sort-row").querySelector(".gen-sort");
      el.disabled = !enabled || !cb.checked;
    });
    const paging = $("#genPaging");
    const pageSize = $("#genPageSize");
    if (paging) paging.disabled = !enabled;
    if (pageSize) pageSize.disabled = !enabled || !(paging && paging.checked);
    const hint = $("#genSearchHint");
    if (hint) hint.textContent = enabled ? "" : "Cần bật action List";
  }

  function genActions() {
    const acts = {};
    document.querySelectorAll(".gen-act").forEach((cb) => (acts[cb.value] = cb.checked));
    return acts;
  }

  function genSearchColumns() {
    return Array.from(document.querySelectorAll("#genSearchFields .gen-search"))
      .filter((el) => el.checked)
      .map((el) => el.value);
  }

  function genSortColumns() {
    return Array.from(document.querySelectorAll("#genSortFields .sort-row"))
      .map((row) => {
        const cb = row.querySelector(".gen-sort");
        return cb && cb.checked
          ? { name: cb.value, desc: row.querySelector(".gen-dir").value === "desc" }
          : null;
      })
      .filter(Boolean);
  }

  function renderGen() {
    const table = state.genTable;
    const codeEl = $("#genCode");
    if (!codeEl) return;

    if (!table) {
      codeEl.textContent = "// Chọn một bảng (hoặc dán CREATE TABLE) để sinh controller CRUD.";
      $("#genMeta").textContent = "Chọn bảng để sinh code";
      state.genCode = "";
      refreshSampleOptions();
      return;
    }

    const model = pascal(table.name);
    const controller = ($("#genController").value.trim() || pluralize(model) + "Controller")
      .replace(/\.cs$/i, "")
      .replace(/Controller$/i, "") + "Controller";
    const context = $("#genContext").value.trim() || "Prn232Context";
    const ns = ($("#genNamespace").value.trim() || "Prn232.ProductApi.Controllers").replace(/[;\s]+$/, "");
    const modelNs = ($("#genModelNs").value.trim() || "Prn232.ProductApi.Models").replace(/[;\s]+$/, "");
    const authorize = $("#genAuthorize").checked;

    const acts = genActions();
    const withList = !!acts.list;
    const searchCols = withList ? genSearchColumns() : [];
    const sortCols = withList ? genSortColumns() : [];

    const pagingOn = withList && $("#genPaging").checked;
    let pageSize = parseInt($("#genPageSize").value, 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
    if (pageSize > 500) pageSize = 500;

    const keys = genKeys(table);

    const cDetail = customMsg("detail", 404);
    const msg404 = csMessage(cDetail && cDetail.text.trim() ? cDetail.text : state.messages.notFound, model, table.name, keys);
    const cCreate = customMsg("create", 400);
    const msgCreateValidation = csMessage(cCreate && cCreate.text.trim() ? cCreate.text : state.messages.validation, model, table.name, keys);
    const cUpdate404 = customMsg("update", 404);
    const msgUpdateNotFound = csMessage(cUpdate404 && cUpdate404.text.trim() ? cUpdate404.text : state.messages.notFound, model, table.name, keys);
    const cUpdate400 = customMsg("update", 400);
    const msgUpdateMismatch = csMessage(cUpdate400 && cUpdate400.text.trim() ? cUpdate400.text : state.messages.mismatch, model, table.name, keys);
    const msgUpdateValidation = csMessage(cUpdate400 && cUpdate400.text.trim() ? cUpdate400.text : state.messages.validation, model, table.name, keys);
    const cDelete = customMsg("delete", 404);
    const msgDeleteNotFound = csMessage(cDelete && cDelete.text.trim() ? cDelete.text : state.messages.notFound, model, table.name, keys);
    const cAuth401 = customMsg("auth", 401);
    const msg401 = csLiteral(cAuth401 && cAuth401.text.trim() ? cAuth401.text : state.messages.unauthorized, model, table.name);
    const cAuth403 = customMsg("auth", 403);
    const msg403 = csLiteral(cAuth403 && cAuth403.text.trim() ? cAuth403.text : state.messages.forbidden, model, table.name);
    const cCreate201 = state.customMessages.filter((m) => m.endpoint === "create" && String(m.status) === "201").pop() || null;
    const cUpdate204 = state.customMessages.filter((m) => m.endpoint === "update" && String(m.status) === "204").pop() || null;
    const cDelete204 = state.customMessages.filter((m) => m.endpoint === "delete" && String(m.status) === "204").pop() || null;
    const cList200 = state.customMessages.filter((m) => m.endpoint === "list" && String(m.status) === "200").pop() || null;
    const cDetail200 = state.customMessages.filter((m) => m.endpoint === "detail" && String(m.status) === "200").pop() || null;

    // Body response khi có custom: chỉ message (đã bỏ custom field)
    const bodyExpr = (entry, fallbackExpr) => {
      if (!entry) return fallbackExpr;
      return `new { message = ${csMessage(entry.text, model, table.name, keys)} }`;
    };

    const route = keys.map((k) => `{${k.param}${k.route}}`).join("/");
    const params = keys.map((k) => `${k.type} ${k.param}`).join(", ");
    const findArgs = keys.map((k) => k.param).join(", ");
    const mismatch = keys.map((k) => `${k.param} != model.${k.prop}`).join(" || ");
    const anyExpr = keys.map((k) => `e.${k.prop} == ${k.param}`).join(" && ");
    const createdArgs = keys.map((k) => `${k.param} = model.${k.prop}`).join(", ");
    const createdUrl = keys.map((k) => `{model.${k.prop}}`).join("/");
    const apiBase = controller.replace(/Controller$/i, "");
    const allActs = ["list", "detail", "create", "update", "delete"].every((k) => acts[k]);

    const L = [];
    L.push(`// [SỬA KHI ĐỔI ĐỀ] Controller sinh tự động cho bảng ${table.name}.`);
    if (!table.columns.some((c) => c.pk)) {
      L.push("// ⚠ Bảng chưa có PRIMARY KEY — code dùng cột đầu tiên làm khóa, kiểm tra lại.");
    }
    L.push("using Microsoft.AspNetCore.Mvc;");
    if (authorize) L.push("using Microsoft.AspNetCore.Authorization;");
    L.push("using Microsoft.EntityFrameworkCore;");
    L.push(`using ${modelNs};`);
    L.push("");
    L.push(`namespace ${ns};`);
    L.push("");
    L.push("[ApiController]");
    L.push('[Route("api/[controller]")]');
    if (authorize) L.push("[Authorize]");
    L.push(`public class ${controller} : ControllerBase`);
    L.push("{");
    L.push(`    private readonly ${context} _context;`);
    L.push("");
    L.push(`    public ${controller}(${context} context)`);
    L.push("    {");
    L.push("        _context = context;");
    L.push("    }");

    // ---------- LIST ----------
    if (withList) {
      L.push("");
      L.push(`    // GET: api/${apiBase}`);
      L.push("    [HttpGet]");
      const listParams = [];
      if (searchCols.length) listParams.push("string? keyword");
      if (pagingOn) listParams.push(`int page = 1, int pageSize = ${pageSize}`);
      const listReturn = pagingOn ? "object" : `IEnumerable<${model}>`;
      L.push(`    public async Task<ActionResult<${listReturn}>> GetAll(${listParams.join(", ")})`);
      L.push("    {");
      L.push(`        var query = _context.Set<${model}>().AsNoTracking();`);

      if (searchCols.length) {
        L.push("");
        L.push("        if (!string.IsNullOrWhiteSpace(keyword))");
        L.push("        {");
        L.push("            query = query.Where(e =>");
        searchCols.forEach((col, i) => {
          L.push(`                (e.${pascal(col)} ?? "").Contains(keyword)${i === searchCols.length - 1 ? ");" : " ||"}`);
        });
        L.push("        }");
      }

      let chain = sortCols
        .map((c, i) => {
          const fn =
            i === 0
              ? c.desc
                ? "OrderByDescending"
                : "OrderBy"
              : c.desc
              ? "ThenByDescending"
              : "ThenBy";
          return `.${fn}(e => e.${pascal(c.name)})`;
        })
        .join("");
      // Phân trang mà không sort -> sắp theo khóa để kết quả ổn định
      if (!chain && pagingOn) chain = `.OrderBy(e => e.${keys[0].prop})`;

      L.push("");
      const cList200 = customMsg("list", 200);
      if (cList200) {
        L.push(`        return Ok(${bodyExpr(cList200)});`);
      } else if (pagingOn) {
        L.push("        if (page < 1) page = 1;");
        L.push(`        if (pageSize < 1) pageSize = ${pageSize};`);
        L.push("");
        L.push("        var total = await query.CountAsync();");
        L.push("        var items = await query");
        if (chain) {
          L.push(`            ${chain}`);
          L.push("            .Skip((page - 1) * pageSize)");
          L.push("            .Take(pageSize)");
          L.push("            .ToListAsync();");
        } else {
          L.push("            .Skip((page - 1) * pageSize)");
          L.push("            .Take(pageSize)");
          L.push("            .ToListAsync();");
        }
        L.push("");
        L.push("        return Ok(new { total, page, pageSize, items });");
      } else {
        L.push(`        var items = await query${chain}.ToListAsync();`);
        L.push("        return Ok(items);");
      }
      L.push("    }");
    }

    // ---------- GET BY ID ----------
    if (acts.detail) {
      L.push("");
      L.push(`    // GET: api/${apiBase}/${route}`);
      L.push(`    [HttpGet("${route}")]`);
      L.push(`    public async Task<ActionResult<${model}>> GetById(${params})`);
      L.push("    {");
      L.push(`        var item = await _context.Set<${model}>().FindAsync(${findArgs});`);
      L.push("        if (item == null)");
      L.push(`            return NotFound(${bodyExpr(cDetail, `new { message = ${msg404} }`)});`);
      if (cDetail200) {
        L.push(`        return Ok(${bodyExpr(cDetail200)});`);
      } else {
        L.push("        return Ok(item);");
      }
      L.push("    }");
    }

    // ---------- CREATE ----------
    if (acts.create) {
      L.push("");
      L.push(`    // POST: api/${apiBase}`);
      L.push("    [HttpPost]");
      L.push(`    public async Task<ActionResult<${model}>> Create(${model} model)`);
      L.push("    {");
      L.push("        if (!ModelState.IsValid)");
      L.push(`            return BadRequest(${bodyExpr(cCreate, "new { message = " + msgCreateValidation + " }")});`);
      L.push("");
      L.push(`        _context.Set<${model}>().Add(model);`);
      L.push("        await _context.SaveChangesAsync();");
      L.push("");
      if (cCreate201) {
        L.push(`        return StatusCode(${cCreate201.status}, ${bodyExpr(cCreate201)});`);
      } else if (acts.detail) {
        L.push(`        return CreatedAtAction(nameof(GetById), new { ${createdArgs} }, model);`);
      } else {
        L.push(`        return Created($"/api/${apiBase}/${createdUrl}", model);`);
      }
      L.push("    }");
    }

    // ---------- UPDATE ----------
    if (acts.update) {
      L.push("");
      L.push(`    // PUT: api/${apiBase}/${route}`);
      L.push(`    [HttpPut("${route}")]`);
      L.push(`    public async Task<IActionResult> Update(${params}, ${model} model)`);
      L.push("    {");
      L.push(`        if (${mismatch})`);
      L.push(`            return BadRequest(${bodyExpr(cUpdate400, "new { message = " + msgUpdateMismatch + " }")});`);
      L.push("        if (!ModelState.IsValid)");
      L.push(`            return BadRequest(${bodyExpr(cUpdate400, "new { message = " + msgUpdateValidation + " }")});`);
      L.push("");
      L.push(`        _context.Set<${model}>().Update(model);`);
      L.push("        try");
      L.push("        {");
      L.push("            await _context.SaveChangesAsync();");
      L.push("        }");
      L.push("        catch (DbUpdateConcurrencyException)");
      L.push("        {");
      L.push(`            if (!await _context.Set<${model}>().AnyAsync(e => ${anyExpr}))`);
      L.push(`                return NotFound(${bodyExpr(cUpdate404, "new { message = " + msgUpdateNotFound + " }")});`);
      L.push("            throw;");
      L.push("        }");
      if (cUpdate204) {
        L.push(`        return StatusCode(${cUpdate204.status}, ${bodyExpr(cUpdate204)});`);
      } else {
        L.push("        return NoContent();");
      }
      L.push("    }");
    }

    // ---------- DELETE ----------
    if (acts.delete) {
      L.push("");
      L.push(`    // DELETE: api/${apiBase}/${route}`);
      L.push(`    [HttpDelete("${route}")]`);
      L.push(`    public async Task<IActionResult> Delete(${params})`);
      L.push("    {");
      L.push(`        var item = await _context.Set<${model}>().FindAsync(${findArgs});`);
      L.push("        if (item == null)");
      L.push(`            return NotFound(${bodyExpr(cDelete, "new { message = " + msgDeleteNotFound + " }")});`);
      L.push("");
      L.push(`        _context.Set<${model}>().Remove(item);`);
      L.push("        await _context.SaveChangesAsync();");
      if (cDelete204) {
        L.push(`        return StatusCode(${cDelete204.status}, ${bodyExpr(cDelete204)});`);
      } else {
        L.push("        return NoContent();");
      }
      L.push("    }");
    }

    if (!withList && !acts.detail && !acts.create && !acts.update && !acts.delete) {
      L.push("");
      L.push("    // Chưa tick action nào — bật action ở panel tuỳ chọn để sinh code.");
    }

    L.push("}");

    state.genCode = L.join("\n");
    codeEl.textContent = state.genCode;

    const actNames = [
      withList ? "list" : null,
      acts.detail ? "detail" : null,
      acts.create ? "create" : null,
      acts.update ? "update" : null,
      acts.delete ? "delete" : null
    ].filter(Boolean);

    $("#genMeta").textContent =
      `${table.name} · ${actNames.length ? actNames.join("+") : "0 action"} · ` +
      (authorize ? "JWT" : "public") +
      (searchCols.length ? ` · search ${searchCols.length}` : "") +
      (sortCols.length ? ` · sort ${sortCols.length}` : "") +
      (pagingOn ? ` · ${pageSize}/trang` : "") +
      (table.columns.some((c) => c.pk) ? "" : " · thiếu PK");
    $("#genSourceMeta").textContent = `${table.name} · ${table.columns.length} field`;
    $("#cmdGenScaffold").textContent =
      `dotnet aspnet-codegenerator controller -name ${controller} -async -api -m ${model} -dc ${context} -outDir Controllers`;

    // Message 401/403 nằm ở middleware JWT (Program.cs), không nằm trong controller
    $("#authEventsCode").textContent = [
      "options.Events = new JwtBearerEvents",
      "{",
      "    OnChallenge = async context =>",
      "    {",
      "        context.HandleResponse();",
      "        context.Response.StatusCode = StatusCodes.Status401Unauthorized;",
      `        await context.Response.WriteAsJsonAsync(new { message = ${msg401} });`,
      "    },",
      "    OnForbidden = async context =>",
      "    {",
      "        context.Response.StatusCode = StatusCodes.Status403Forbidden;",
      `        await context.Response.WriteAsJsonAsync(new { message = ${msg403} });`,
      "    }",
      "};",
      "",
      "// Dán vào trong .AddJwtBearer(options => { ... }), giữ nguyên TokenValidationParameters phía trên."
    ].join("\n");
    $("#authMsgCard").hidden = !authorize;
    $("#msgUnauthorized").disabled = !authorize;
    $("#msgForbidden").disabled = !authorize;

    refreshSampleOptions();
  }

  // Sinh controller OData CRUD cho 1 bảng: list dung [EnableQuery] (IQueryable -> $filter/$orderby/$top/$skip/$count).
  function refreshOdataOptions() {
    const sel = $("#odataTable");
    if (!sel) return;
    const list = state.tables.slice();
    if (state.genTable) {
      const fresh = state.tables.find((t) => t.name === state.genTable.name);
      if (fresh) state.genTable = fresh;
      else if (!list.some((t) => t.name === state.genTable.name)) list.unshift(state.genTable);
    }
    sel.innerHTML = list.length
      ? list.map((t) => `<option value="${esc(t.name)}">${esc(t.name)} · ${t.columns.length} field</option>`).join("")
      : `<option value="">— chưa có bảng —</option>`;
    if (state.genTable) sel.value = state.genTable.name;
    else if (list.length) sel.value = list[0].name;
    renderOdata();
  }

  // Code controller OData CRUD: GET list -> IQueryable + [EnableQuery]; GET/POST/PUT/DELETE dung EF.
  function renderOdata() {
    const codeEl = $("#odataCode");
    if (!codeEl) return;
    const sel = $("#odataTable");
    const name = (sel && sel.value) || (state.genTable && state.genTable.name) || "";
    const table = state.tables.find((t) => t.name === name) || state.genTable || null;
    if (!table) {
      codeEl.textContent = "// Chọn bảng để sinh controller OData CRUD.";
      $("#odataMeta").textContent = "Chọn bảng để sinh code";
      state.odataCode = "";
      return;
    }

    const model = pascal(table.name);
    const controller = ($("#genController").value.trim() || pluralize(model) + "Controller")
      .replace(/\.cs$/i, "")
      .replace(/Controller$/i, "") + "Controller";
    const context = $("#genContext").value.trim() || "Prn232Context";
    const ns = ($("#genNamespace").value.trim() || "Prn232.ProductApi.Controllers").replace(/[;\s]+$/, "");
    const modelNs = ($("#genModelNs").value.trim() || "Prn232.ProductApi.Models").replace(/[;\s]+$/, "");
    const authorize = $("#genAuthorize").checked;

    const keys = genKeys(table);
    const key = keys[0];
    const cDetail = customMsg("detail", 404);
    const msgDetail = csMessage(cDetail && cDetail.text.trim() ? cDetail.text : state.messages.notFound, model, table.name, keys);
    const cUpdate404 = customMsg("update", 404);
    const msgUpdateNotFound = csMessage(cUpdate404 && cUpdate404.text.trim() ? cUpdate404.text : state.messages.notFound, model, table.name, keys);

    const apiBase = controller.replace(/Controller$/i, "");

    const L = [];
    L.push(`// [SỬA KHI ĐỔI ĐỔI] Controller OData CRUD cho bảng ${table.name}.`);
    L.push("using Microsoft.AspNetCore.Mvc;");
    if (authorize) L.push("using Microsoft.AspNetCore.Authorization;");
    L.push("using Microsoft.AspNetCore.OData;");
    L.push("using Microsoft.EntityFrameworkCore;");
    L.push(`using ${modelNs};`);
    L.push("");
    L.push(`namespace ${ns};`);
    L.push("");
    L.push("[ApiController]");
    L.push('[Route("api/[controller]")]');
    if (authorize) L.push("[Authorize]");
    L.push(`public class ${controller} : ControllerBase`);
    L.push("{");
    L.push(`    private readonly ${context} _context;`);
    L.push("");
    L.push(`    public ${controller}(${context} context)`);
    L.push("    {");
    L.push("        _context = context;");
    L.push("    }");
    L.push("");
    L.push("    // GET: api/" + apiBase);
    L.push("    [HttpGet]");
    L.push("    [EnableQuery]");
    L.push(`    public async Task<IQueryable<${model}>> Get()`);
    L.push("    {");
    L.push(`        return _context.Set<${model}>().AsNoTracking();`);
    L.push("    }");
    L.push("");
    L.push("    // GET: api/" + apiBase + "/{id}");
    L.push('    [HttpGet("{id}")]');
    L.push("    [EnableQuery]");
    L.push(`    public async Task<IActionResult> Get(${key.type} ${key.param})`);
    L.push("    {");
    L.push(`        var item = await _context.Set<${model}>().FindAsync(new object[] { ${key.param} });`);
    L.push("        if (item == null)");
    L.push("        {");
    L.push(`            return NotFound(new { message = ${msgDetail} });`);
    L.push("        }");
    L.push("        return Ok(item);");
    L.push("    }");
    L.push("");
    L.push(`    // POST: api/${apiBase}`);
    L.push("    [HttpPost]");
    L.push(`    public async Task<IActionResult> Post(${model} product)`);
    L.push("    {");
    L.push(`        _context.Set<${model}>().Add(product);`);
    L.push("        await _context.SaveChangesAsync();");
    L.push('        return Created($"/api/' + apiBase + '/{product.' + key.prop + '}", product);');
    L.push("    }");
    L.push("");
    L.push("    // PUT: api/" + apiBase + "/{id}");
    L.push('    [HttpPut("{id}")]');
    L.push(`    public async Task<IActionResult> Put(${key.type} ${key.param}, ${model} product)`);
    L.push("    {");
    L.push(`        var entity = await _context.Set<${model}>().FindAsync(new object[] { ${key.param} });`);
    L.push("        if (entity == null)");
    L.push("        {");
    L.push(`            return NotFound(new { message = ${msgUpdateNotFound} });`);
    L.push("        }");
    L.push("        _context.Entry(entity).CurrentValues.SetValues(product);");
    L.push("        await _context.SaveChangesAsync();");
    L.push("        return NoContent();");
    L.push("    }");
    L.push("");
    L.push("    // DELETE: api/" + apiBase + "/{id}");
    L.push('    [HttpDelete("{id}")]');
    L.push(`    public async Task<IActionResult> Delete(${key.type} ${key.param})`);
    L.push("    {");
    L.push(`        var entity = await _context.Set<${model}>().FindAsync(new object[] { ${key.param} });`);
    L.push("        if (entity == null)");
    L.push("        {");
    L.push(`            return NotFound(new { message = ${msgUpdateNotFound} });`);
    L.push("        }");
    L.push(`        _context.Set<${model}>().Remove(entity);`);
    L.push("        await _context.SaveChangesAsync();");
    L.push("        return NoContent();");
    L.push("    }");
    L.push("}");

    state.odataCode = L.join("\n");
    codeEl.textContent = state.odataCode;
    $("#odataMeta").textContent = `${table.name} · OData CRUD`;

    // Snippet cài đặt OData cho Program.cs của API
    const P = [];
    P.push("using Microsoft.AspNetCore.OData;");
    P.push("");
    P.push("// [SỬA KHI ĐỔI ĐỔI] OData: cho phép query $filter / $orderby / $top / $skip / $count / $select / $expand");
    P.push("builder.Services.AddControllers().AddOData(options => options.Select().Filter().OrderBy().Count().Expand());");
    $("#odataProgramCode").textContent = P.join("\n");
  }

  // =====================================================================
  // SINH DBCONTEXT
  // =====================================================================
  // Tên DbSet = số nhiều Pascal của tên bảng (Product -> Products)
  function ctxDbSetName(table) {
    return pluralize(pascal(table.name));
  }

  // Code DbContext sinh tự động: constructor + DbSet + OnModelCreating
  function buildDbContextCode(tables, contextName, ns) {
    const ctx = (contextName || "").trim() || "Prn232Context";
    const nsClean = (ns || "").trim().replace(/[;\s]+$/, "") || "Prn232.ProductApi.Models";
    const names = tables.map((t) => t.name);

    const L = [];
    L.push(`// [SỬA KHI ĐỔI ĐỀ] DbContext sinh tự động cho bảng: ${names.join(", ")}.`);
    L.push("");
    L.push("using System;");
    L.push("using System.Collections.Generic;");
    L.push("using Microsoft.EntityFrameworkCore;");
    L.push("");
    L.push(`namespace ${nsClean};`);
    L.push("");
    L.push(`public partial class ${ctx} : DbContext`);
    L.push("{");
    L.push(`    public ${ctx}(DbContextOptions<${ctx}> options)`);
    L.push("        : base(options)");
    L.push("    {");
    L.push("    }");
    L.push("");
    tables.forEach((t, i) => {
      L.push(`    public virtual DbSet<${pascal(t.name)}> ${ctxDbSetName(t)} { get; set; }`);
      if (i < tables.length - 1) L.push("");
    });
    L.push("");
    L.push("    protected override void OnModelCreating(ModelBuilder modelBuilder)");
    L.push("    {");
    tables.forEach((t, i) => {
      if (i > 0) L.push("");
      L.push(`        modelBuilder.Entity<${pascal(t.name)}>(entity =>`);
      L.push("        {");
      const pkCols = t.columns.filter((c) => c.pk);
      const keyCols = pkCols.length ? pkCols : t.columns.slice(0, 1);
      L.push(`            entity.HasKey(${keyCols.map((c) => `e => e.${pascal(c.name)}`).join(", ")});`);
      L.push("");
      L.push(`            entity.ToTable("${t.name}");`);
      const pl = [];
      t.columns.forEach((c) => {
        if (c.pk || c.computed) return;
        const m = /^([A-Za-z]+)(?:\(([^)]*)\))?$/.exec(c.type);
        const baseT = (m ? m[1] : c.type).toUpperCase();
        const len = m && m[2] ? parseInt(m[2], 10) : null;
        if (/^(CHAR|VARCHAR|NCHAR|NVARCHAR|TEXT|NTEXT|SYSNAME|XML)$/.test(baseT) && len) {
          pl.push(`            entity.Property(e => e.${pascal(c.name)}).HasMaxLength(${len});`);
        }
        if (c.defaultValue) {
          const d = String(c.defaultValue).trim();
          const prop = `entity.Property(e => e.${pascal(c.name)})`;
          if (/^-?\d+(\.\d+)?$/.test(d)) {
            pl.push(`            ${prop}.HasDefaultValue(${d});`);
          } else if (/^'.*'$/.test(d)) {
            const lit = d.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
            pl.push(`            ${prop}.HasDefaultValue("${lit}");`);
          } else {
            pl.push(`            ${prop}.HasDefaultValueSql("${d}");`);
          }
        }
      });
      if (pl.length) {
        L.push("");
        pl.forEach((l) => L.push(l));
      }
      const uniqCols = [];
      (t.uniques || []).forEach((u) => {
        if (u && u.length === 1 && !uniqCols.includes(u[0])) uniqCols.push(u[0]);
      });
      t.columns.forEach((c) => {
        if (c.unique && !c.pk && !uniqCols.includes(c.name)) uniqCols.push(c.name);
      });
      if (uniqCols.length) {
        L.push("");
        L.push(`            entity.HasIndex(e => e.${pascal(uniqCols[0])}).IsUnique();`);
      }
      L.push("        }");
    });
    L.push("");
    L.push("        OnModelCreatingPartial(modelBuilder);");
    L.push("    }");
    L.push("");
    L.push("    partial void OnModelCreatingPartial(ModelBuilder modelBuilder);");
    L.push("}");
    return L.join("\n");
  }

  // Bảng để chọn: phân tích được + bảng vừa dán (genTable)
  function ctxTablePool() {
    const list = state.tables.slice();
    if (state.genTable) {
      const fresh = state.tables.find((t) => t.name === state.genTable.name);
      if (fresh) state.genTable = fresh;
      else if (!list.some((t) => t.name === state.genTable.name)) list.unshift(state.genTable);
    }
    return list;
  }

  function refreshCtxOptions() {
    const box = $("#ctxChecks");
    if (!box) return;
    const list = ctxTablePool();
    box.innerHTML = list.length
      ? list
          .map(
            (t) =>
              `<label class="check-row"><input type="checkbox" class="ctx-check" value="${esc(t.name)}" /><span><code>${esc(t.name)}</code> · ${t.columns.length} field</span></label>`
          )
          .join("")
      : `<span class="muted">Chưa có bảng — vào tab “Cấu trúc bảng” để phân tích SQL trước.</span>`;
  }

  function setCtxCheck(name, on) {
    document.querySelectorAll("#ctxChecks .ctx-check").forEach((cb) => {
      if (cb.value === name) cb.checked = on;
    });
  }

  function renderCtx() {
    const codeEl = $("#ctxCode");
    if (!codeEl) return;
    const pool = ctxTablePool();
    const tables = [];
    document.querySelectorAll("#ctxChecks .ctx-check").forEach((cb) => {
      if (!cb.checked) return;
      const t = pool.find((x) => x.name === cb.value);
      if (t) tables.push(t);
    });

    const ctxName = ($("#ctxContext").value.trim() || "Prn232Context").replace(/\.cs$/i, "");
    const { conn } = connInfo();
    const parts = [
      `dotnet ef dbcontext scaffold "${conn}"`,
      "Microsoft.EntityFrameworkCore.SqlServer",
      "-o Models",
      "-f",
      `-c ${ctxName}`,
      "--no-onconfiguring"
    ];
    if (tables.length) parts.push(tables.map((t) => `-t ${t.name}`).join(" "));
    $("#ctxScaffoldCmd").textContent = parts.join(" ");

    if (!tables.length) {
      codeEl.textContent = "// Chọn bảng để sinh DbContext.";
      $("#ctxMeta").textContent = "Chọn bảng để sinh code";
      $("#ctxSourceMeta").textContent = "Chưa có bảng";
      return;
    }

    const code = buildDbContextCode(tables, ctxName, $("#ctxNamespace").value);
    state.ctxCode = code;
    codeEl.textContent = code;

    const names = tables.map((t) => t.name).join(", ");
    $("#ctxMeta").textContent = `${ctxName} · ${names}`;
    $("#ctxSourceMeta").textContent = `${names} · ${tables.length} bảng`;
  }

  // =====================================================================
  // KẾT QUẢ MẪU CỦA ENDPOINT
  // =====================================================================
  // Sinh Razor Page CRUD cho 1 bảng: backend IndexModel (OnGet -> ApiClient) + view Index.cshtml
  function buildRazorCode(table) {
    const plural = pluralize(pascal(table.name));
    const model = pascal(table.name);
    const dto = `${model}Dto`;
    const apiMethod = `Get${plural}Async`;
    const pageNs = `Prn232.Fe.Pages.${plural}`;

    const L = [];
    L.push("using Microsoft.AspNetCore.Mvc;");
    L.push("using Microsoft.AspNetCore.Mvc.RazorPages;");
    L.push("using Prn232.Fe.Models;");
    L.push("using Prn232.Fe.Services;");
    L.push("");
    L.push(`namespace ${pageNs};`);
    L.push("");
    L.push("public class IndexModel : PageModel");
    L.push("{");
    L.push("    // Số dòng mỗi trang — sửa 1 chỗ này là đổi phân trang");
    L.push("    private const int PageSize = 5;");
    L.push("");
    L.push("    private readonly ApiClient _api;");
    L.push("");
    L.push("    public IndexModel(ApiClient api)");
    L.push("    {");
    L.push("        _api = api;");
    L.push("    }");
    L.push("");
    L.push(`    public List<${dto}> Items { get; private set; } = new();`);
    L.push("    public int PageNumber { get; private set; } = 1;");
    L.push("    public int TotalPages { get; private set; } = 1;");
    L.push("    public int Total { get; private set; }");
    L.push("    public string? Search { get; private set; }");
    L.push("    public string? ErrorMessage { get; private set; }");
    L.push("");
    L.push("    [TempData]");
    L.push("    public string? Message { get; set; }");
    L.push("");
    L.push("    public async Task<IActionResult> OnGetAsync(int page = 1, string? search = null)");
    L.push("    {");
    L.push("        if (string.IsNullOrEmpty(HttpContext.Session.GetString(\"accessToken\")))");
    L.push("        {");
    L.push("            return RedirectToPage(\"/Login\");");
    L.push("        }");
    L.push("");
    L.push("        try");
    L.push("        {");
    L.push(`            var result = await _api.${apiMethod}(page, PageSize, search);`);
    L.push("            if (result == null)");
    L.push("            {");
    L.push("                ErrorMessage = _api.ErrorMessage;");
    L.push("                return Page();");
    L.push("            }");
    L.push("");
    L.push("            Items = result.Items;");
    L.push("            PageNumber = result.Page;");
    L.push("            TotalPages = Math.Max(1, result.TotalPages);");
    L.push("            Total = result.Total;");
    L.push("            Search = search;");
    L.push("        }");
    L.push("        catch (UnauthorizedAccessException)");
    L.push("        {");
    L.push("            HttpContext.Session.Clear();");
    L.push("            return RedirectToPage(\"/Login\");");
    L.push("        }");
    L.push("");
    L.push("        return Page();");
    L.push("    }");
    L.push("}");
    const cs = L.join("\n");

    const fields = table.columns.filter((c) => !c.computed);
    const F = [];
    fields.forEach((c) => F.push(`                <th>${c.name}</th>`));
    const C = [];
    fields.forEach((c) => C.push(`                    <td>@item.${pascal(c.name)}</td>`));

    const H = [];
    H.push("@page");
    H.push(`@model ${pageNs}.IndexModel`);
    H.push("@{");
    H.push(`    ViewData["Title"] = "${table.name}";`);
    H.push("}");
    H.push("");
    H.push('<div class="d-flex justify-content-between align-items-center mb-3">');
    H.push(`    <h2>Danh sách ${table.name}</h2>`);
    H.push("</div>");
    H.push("");
    H.push("@if (!string.IsNullOrEmpty(Model.Message))");
    H.push("{");
    H.push("    <div class=\"alert alert-success\">@Model.Message</div>");
    H.push("}");
    H.push("");
    H.push("@if (!string.IsNullOrEmpty(Model.ErrorMessage))");
    H.push("{");
    H.push("    <div class=\"alert alert-danger\">@Model.ErrorMessage</div>");
    H.push("}");
    H.push("");
    H.push("@if (Model.Total == 0)");
    H.push("{");
    H.push("    <div class=\"alert alert-info\">Không có dữ liệu</div>");
    H.push("}");
    H.push("");
    H.push("@if (Model.Total > 0)");
    H.push("{");
    H.push("    <table class=\"table table-bordered table-striped\">");
    H.push("        <thead>");
    H.push("            <tr>");
    H.push(F.join("\n"));
    H.push("            </tr>");
    H.push("        </thead>");
    H.push("        <tbody>");
    H.push("            @foreach (var item in Model.Items)");
    H.push("            {");
    H.push("                <tr>");
    H.push(C.join("\n"));
    H.push("                </tr>");
    H.push("            }");
    H.push("        </tbody>");
    H.push("    </table>");
    H.push("}");
    const cshtml = H.join("\n");

    return { cshtml, cs };
  }

  function refreshRazorOptions() {
    const sel = $("#razorTable");
    if (!sel) return;
    const list = ctxTablePool();
    sel.innerHTML = list.length
      ? list.map((t) => `<option value="${esc(t.name)}">${esc(t.name)} · ${t.columns.length} field</option>`).join("")
      : `<option value="">— chưa có bảng —</option>`;
    if (state.genTable) sel.value = state.genTable.name;
    else if (list.length) sel.value = list[0].name;
  }

  function setRazorTable(table) {
    if (table) {
      state.genTable = table;
      const sel = $("#razorTable");
      if (sel) sel.value = table.name;
    }
    renderRazor();
  }

  function renderRazor() {
    const codeEl = $("#razorCode");
    const csEl = $("#razorCs");
    if (!codeEl) return;
    const table = state.genTable;
    if (!table) {
      codeEl.textContent = "// Chọn bảng để sinh Razor Page CRUD.";
      if (csEl) csEl.textContent = "// Chọn bảng để sinh Razor Page CRUD.";
      $("#razorMeta").textContent = "Chọn bảng để sinh code";
      $("#razorSourceMeta").textContent = "Chọn bảng để sinh Razor Page";
      return;
    }
    const { cshtml, cs } = buildRazorCode(table);
    state.razorCode = cshtml;
    state.razorCs = cs;
    codeEl.textContent = cshtml;
    if (csEl) csEl.textContent = cs;
    const plural = pluralize(pascal(table.name));
    $("#razorMeta").textContent = `${plural} · Index`;
    $("#razorSourceMeta").textContent = `${table.name} · ${table.columns.length} field`;
  }

  // Sinh trang Razor Login: backend OnPostAsync (ApiClient.LoginAsync) + view Login.cshtml
  function buildLoginCode() {
    const L = [];
    L.push("using System.ComponentModel.DataAnnotations;");
    L.push("using Microsoft.AspNetCore.Mvc;");
    L.push("using Microsoft.AspNetCore.Mvc.RazorPages;");
    L.push("using Prn232.Fe.Services;");
    L.push("");
    L.push("namespace Prn232.Fe.Pages;");
    L.push("");
    L.push("public class LoginModel : PageModel");
    L.push("{");
    L.push("    private readonly ApiClient _api;");
    L.push("");
    L.push("    public LoginModel(ApiClient api)");
    L.push("    {");
    L.push("        _api = api;");
    L.push("    }");
    L.push("");
    L.push("    [BindProperty]");
    L.push("    public LoginInput Input { get; set; } = new();");
    L.push("");
    L.push("    public string? ErrorMessage { get; set; }");
    L.push("");
    L.push("    public IActionResult OnGet()");
    L.push("    {");
    L.push("        if (!string.IsNullOrEmpty(HttpContext.Session.GetString(\"accessToken\")))");
    L.push("        {");
    L.push("            return RedirectToPage(\"/Products/Index\");");
    L.push("        }");
    L.push("");
    L.push("        return Page();");
    L.push("    }");
    L.push("");
    L.push("    public async Task<IActionResult> OnPostAsync()");
    L.push("    {");
    L.push("        if (!ModelState.IsValid)");
    L.push("        {");
    L.push("            return Page();");
    L.push("        }");
    L.push("");
    L.push("        var result = await _api.LoginAsync(Input.Username, Input.Password);");
    L.push("        if (result == null)");
    L.push("        {");
    L.push("            ErrorMessage = _api.ErrorMessage ?? \"Đăng nhập thất bại\";");
    L.push("            return Page();");
    L.push("        }");
    L.push("");
    L.push("        HttpContext.Session.SetString(\"accessToken\", result.AccessToken);");
    L.push("        HttpContext.Session.SetString(\"username\", result.Username);");
    L.push("        HttpContext.Session.SetString(\"role\", result.Role);");
    L.push("");
    L.push("        return RedirectToPage(\"/Products/Index\");");
    L.push("    }");
    L.push("");
    L.push("    public class LoginInput");
    L.push("    {");
    L.push("        [Required(ErrorMessage = \"Nhập username\")]");
    L.push("        public string Username { get; set; } = \"\";");
    L.push("");
    L.push("        [Required(ErrorMessage = \"Nhập password\")]");
    L.push("        public string Password { get; set; } = \"\";");
    L.push("    }");
    L.push("}");
    const cs = L.join("\n");

    const H = [];
    H.push("@page");
    H.push("@model LoginModel");
    H.push("@{");
    H.push("    ViewData[\"Title\"] = \"Login\";");
    H.push("}");
    H.push("");
    H.push("<h2>Đăng nhập</h2>");
    H.push("");
    H.push("<div class=\"row\">");
    H.push("    <div class=\"col-md-4\">");
    H.push("        <form method=\"post\">");
    H.push("            <div asp-validation-summary=\"ModelOnly\" class=\"text-danger\"></div>");
    H.push("");
    H.push("            @if (!string.IsNullOrEmpty(Model.ErrorMessage))");
    H.push("            {");
    H.push("                <div class=\"alert alert-danger\">@Model.ErrorMessage</div>");
    H.push("            }");
    H.push("");
    H.push("            <div class=\"mb-3\">");
    H.push("                <label asp-for=\"Input.Username\" class=\"form-label\">Username</label>");
    H.push("                <input asp-for=\"Input.Username\" class=\"form-control\" autocomplete=\"username\" />");
    H.push("                <span asp-validation-for=\"Input.Username\" class=\"text-danger\"></span>");
    H.push("            </div>");
    H.push("");
    H.push("            <div class=\"mb-3\">");
    H.push("                <label asp-for=\"Input.Password\" class=\"form-label\">Password</label>");
    H.push("                <input asp-for=\"Input.Password\" class=\"form-control\" autocomplete=\"current-password\" />");
    H.push("                <span asp-validation-for=\"Input.Password\" class=\"text-danger\"></span>");
    H.push("            </div>");
    H.push("");
    H.push("            <button type=\"submit\" class=\"btn btn-primary\">Login</button>");
    H.push("        </form>");
    H.push("");
    H.push("        <p class=\"text-muted mt-3\">Tài khoản mẫu: <code>admin / 123456</code></p>");
    H.push("    </div>");
    H.push("</div>");
    const cshtml = H.join("\n");

    return { cshtml, cs };
  }

  // Sinh backend BE login (AuthApi) — nằm trong project Prn232.AuthApi
  function buildLoginApiCode() {
    const L = [];
    L.push("using Microsoft.AspNetCore.Authorization;");
    L.push("using Microsoft.AspNetCore.Mvc;");
    L.push("using Microsoft.EntityFrameworkCore;");
    L.push("using Prn232.AuthApi.Models;");
    L.push("using Prn232.AuthApi.Services;");
    L.push("");
    L.push("namespace Prn232.AuthApi.Controllers;");
    L.push("");
    L.push("[ApiController]");
    L.push("[Route(\"api/auth\")]");
    L.push("public class AuthController : ControllerBase");
    L.push("{");
    L.push("    private readonly Prn232Context _context;");
    L.push("    private readonly TokenService _tokenService;");
    L.push("");
    L.push("    public AuthController(Prn232Context context, TokenService tokenService)");
    L.push("    {");
    L.push("        _context = context;");
    L.push("        _tokenService = tokenService;");
    L.push("    }");
    L.push("");
    L.push("    // POST /api/auth/login");
    L.push("    // [SỬA KHI ĐỔI ĐỀ] Đổi bảng Account / field username-password theo model của đề.");
    L.push("    [HttpPost(\"login\")]");
    L.push("    public async Task<IActionResult> Login([FromBody] LoginRequest request)");
    L.push("    {");
    L.push("        // Password đang so sánh plaintext cho nhanh thi (xem ghi chú trong init.sql).");
    L.push("        var account = await _context.Accounts");
    L.push("            .FirstOrDefaultAsync(a => a.Username == request.Username && a.Password == request.Password);");
    L.push("");
    L.push("        if (account == null)");
    L.push("        {");
    L.push("            return Unauthorized(new { message = \"Sai username hoặc password\" });");
    L.push("        }");
    L.push("");
    L.push("        var token = _tokenService.CreateToken(account);");
    L.push("");
    L.push("        return Ok(new");
    L.push("        {");
    L.push("            accessToken = token,");
    L.push("            username = account.Username,");
    L.push("            role = account.Role");
    L.push("        });");
    L.push("    }");
    L.push("");
    L.push("    // GET /api/auth/me");
    L.push("    [Authorize]");
    L.push("    [HttpGet(\"me\")]");
    L.push("    public IActionResult Me()");
    L.push("    {");
    L.push("        return Ok(new");
    L.push("        {");
    L.push("            username = User.FindFirst(\"username\")?.Value ?? User.Identity?.Name,");
    L.push("            role = User.FindFirst(\"role\")?.Value");
    L.push("        });");
    L.push("    }");
    L.push("}");
    L.push("");
    L.push("public class LoginRequest");
    L.push("{");
    L.push("    public string Username { get; set; } = \"\";");
    L.push("    public string Password { get; set; } = \"\";");
    L.push("}");
    return { cs: L.join("\n") };
  }

  function renderLogin() {
    const codeEl = $("#loginCode");
    const csEl = $("#loginCs");
    if (!codeEl) return;
    const { cshtml, cs } = buildLoginCode();
    const { cs: authApi } = buildLoginApiCode();
    state.loginCode = cshtml;
    state.loginCs = cs;
    state.loginApiCode = authApi;
    codeEl.textContent = cshtml;
    if (csEl) csEl.textContent = cs;
    const apiEl = $("#loginApiCode");
    if (apiEl) apiEl.textContent = authApi;
    $("#loginMeta").textContent = "Login · AuthApi";
  }

  // Snippet LINQ de tao query list: filter / sort / search + Include FK.
  // Day la minh hoa cho user doc, user tu thay doi query.
  function buildLinqCode() {
    const L = [];
    L.push("// GET: api/Products");
    L.push("var query = _context.Set<Product>().AsNoTracking();");
    L.push("");
    L.push("// [SỬA KHI ĐỔI ĐỔI] Thêm filter / search / sort theo ý cần:");
    L.push("// query = query.Where(e => e.Price > 100);");
    L.push("// query = query.Where(e => e.Name.Contains(keyword));");
    L.push("query = query.OrderBy(e => e.Name).ThenBy(e => e.Price);");
    L.push("");
    L.push("var items = await query.ToListAsync();");
    L.push("");
    L.push("// Nối bảng theo khóa ngoại (Include) — ví dụ: Product -> Category:");
    L.push("var itemsWithFk = await _context.Set<Product>()");
    L.push("    .Include(e => e.Category)");
    L.push("    .ToListAsync();");
    L.push("");
    L.push("return Ok(items);");
    return L.join("\n");
  }

  function renderLinq() {
    const codeEl = $("#linqCode");
    if (!codeEl) return;
    state.linqCode = buildLinqCode();
    codeEl.textContent = state.linqCode;
    $("#linqMeta").textContent = "Cách dùng LINQ · tham khảo";
  }

  function sqlBaseType(sqlType) {
    return String(sqlType || "").toUpperCase().replace(/\(.*$/, "").trim();
  }

  // Escape chuỗi cho C#
  function csEscape(text) {
    return String(text == null ? "" : text)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, "\\n");
  }

  // Message 404/400: hỗ trợ {model}, {table}, {id} (interpolation khi có {id})
  function csMessage(tpl, model, tableName, keys) {
    let s = String(tpl == null ? "" : tpl)
      .replace(/\{model\}/g, model)
      .replace(/\{table\}/g, tableName);
    if (keys && keys.length > 1) {
      s = s.replace(/\{id\}/g, keys.map((k) => `{${k.param}}`).join("/"));
    }
    const lit = csEscape(s);
    return /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(lit) ? '$"' + lit + '"' : '"' + lit + '"';
  }

  // Message 401/403: luôn là chuỗi thường (không interpolation)
  function csLiteral(tpl, model, tableName) {
    const s = String(tpl == null ? "" : tpl)
      .replace(/\{model\}/g, model)
      .replace(/\{table\}/g, tableName);
    return '"' + csEscape(s) + '"';
  }

  // Hiển thị message thật trong kết quả mẫu
  function sampleMessage(tpl, model, tableName, table, keys) {
    return String(tpl == null ? "" : tpl)
      .replace(/\{model\}/g, model)
      .replace(/\{table\}/g, tableName)
      .replace(/\{id\}/g, sampleKeyPath(table, keys));
  }

  // Giá trị mẫu theo kiểu cột SQL
  function sampleValue(col) {
    const t = sqlBaseType(col.type);
    if (/^(INT|BIGINT|SMALLINT|TINYINT|DECIMAL|NUMERIC|FLOAT|REAL|MONEY|SMALLMONEY)$/.test(t)) return 0;
    if (/^BIT$/.test(t)) return false;
    if (/^UNIQUEIDENTIFIER$/.test(t)) return "00000000-0000-0000-0000-000000000000";
    if (/^(DATE|DATETIME|DATETIME2|SMALLDATETIME|DATETIMEOFFSET)$/.test(t)) return "2026-01-01T00:00:00";
    if (/^TIME$/.test(t)) return "00:00:00";
    if (/^(BINARY|VARBINARY|IMAGE)$/.test(t)) return "string";
    if (/^(CHAR|VARCHAR|NCHAR|NVARCHAR|TEXT|NTEXT|SYSNAME)$/.test(t)) return "string";
    return null;
  }

  function sampleModel(table) {
    const obj = {};
    table.columns.forEach((c) => {
      obj[camel(c.name)] = sampleValue(c);
    });
    return obj;
  }

  // /api/Products/0 hoặc /api/Products/0/0 với PK phức hợp
  function sampleKeyPath(table, keys) {
    return keys
      .map((k) => {
        const col = table.columns.find((c) => pascal(c.name) === k.prop);
        const v = col ? sampleValue(col) : 0;
        return encodeURIComponent(String(v === null ? "string" : v));
      })
      .join("/");
  }

  function genApiBase() {
    const controller = ($("#genController").value.trim() || "ItemsController")
      .replace(/\.cs$/i, "")
      .replace(/Controller$/i, "") + "Controller";
    return controller.replace(/Controller$/i, "");
  }

  function resBlock(tone, status, title, body, headers) {
    return `<div class="res-block">
      <div class="res-head">
        <span class="status ${tone}">${esc(status)}</span>
        <span class="res-title">${esc(title)}</span>
      </div>
      ${headers ? `<div class="res-headers">${esc(headers)}</div>` : ""}
      <pre>${esc(body)}</pre>
    </div>`;
  }

  // Dropdown endpoint theo action đang tick
  function refreshSampleOptions() {
    const sel = $("#sampleEndpoint");
    if (!sel) return;
    const table = state.genTable;
    const acts = genActions();
    const api = genApiBase();
    const items = [];

    if (table) {
      if (acts.list) items.push(["list", `GET /api/${api} — list`]);
      if (acts.detail) items.push(["detail", `GET /api/${api}/{id} — chi tiết`]);
      if (acts.create) items.push(["create", `POST /api/${api} — tạo`]);
      if (acts.update) items.push(["update", `PUT /api/${api}/{id} — sửa`]);
      if (acts.delete) items.push(["delete", `DELETE /api/${api}/{id} — xoá`]);
    }

    const prev = sel.value;
    sel.innerHTML = items.length
      ? items.map((i) => `<option value="${i[0]}">${esc(i[1])}</option>`).join("")
      : `<option value="">— chưa có endpoint —</option>`;
    if (items.some((i) => i[0] === prev)) sel.value = prev;
    sel.disabled = !items.length;

    renderSample();
  }

  function renderSample() {
    const out = $("#sampleOut");
    const sel = $("#sampleEndpoint");
    if (!out || !sel) return;
    const table = state.genTable;
    const acts = genActions();

    if (!table || !sel.value) {
      out.innerHTML = `<p class="out-hint">Chọn bảng + tick ít nhất 1 action để xem kết quả mẫu.</p>`;
      return;
    }

    const model = pascal(table.name);
    const api = genApiBase();
    const keys = genKeys(table);
    const keyPath = sampleKeyPath(table, keys);
    const obj = sampleModel(table);
    const json = (v) => JSON.stringify(v, null, 2);
    const authorize = $("#genAuthorize").checked;
    const pagingOn = acts.list && $("#genPaging").checked;
    let pageSize = parseInt($("#genPageSize").value, 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
    if (pageSize > 500) pageSize = 500;
    const searchCols = acts.list ? genSearchColumns() : [];
    const cList200 = state.customMessages.filter((m) => m.endpoint === "list" && String(m.status) === "200").pop() || null;

    const cDetail = customMsg("detail", 404);
    const tpl404 = cDetail && cDetail.text.trim() ? cDetail.text : state.messages.notFound;
    const cCreate = customMsg("create", 400);
    const tplCreateValidation = cCreate && cCreate.text.trim() ? cCreate.text : state.messages.validation;
    const cUpdate404 = customMsg("update", 404);
    const tplUpdateNotFound = cUpdate404 && cUpdate404.text.trim() ? cUpdate404.text : state.messages.notFound;
    const cUpdate400 = customMsg("update", 400);
    const tplUpdateMismatch = cUpdate400 && cUpdate400.text.trim() ? cUpdate400.text : state.messages.mismatch;
    const tplUpdateValidation = cUpdate400 && cUpdate400.text.trim() ? cUpdate400.text : state.messages.validation;
    const cDelete = customMsg("delete", 404);
    const tplDeleteNotFound = cDelete && cDelete.text.trim() ? cDelete.text : state.messages.notFound;
    const tpl401 = (customMsg("auth", 401) && customMsg("auth", 401).text.trim() ? customMsg("auth", 401).text : state.messages.unauthorized);
    const notFoundDetailBody = json({ message: sampleMessage(tpl404, model, table.name, table, keys) });
    const notFoundDeleteBody = json({ message: sampleMessage(tplDeleteNotFound, model, table.name, table, keys) });
    const validationCreateBody = json({ message: sampleMessage(tplCreateValidation, model, table.name, table, keys) });
    const validationUpdateBody = json({ message: sampleMessage(tplUpdateValidation, model, table.name, table, keys) });
    const mismatchUpdateBody = json({ message: sampleMessage(tplUpdateMismatch, model, table.name, table, keys) });
    const customSampleBody = (e) => json({ message: sampleMessage(e.text, model, table.name, table, keys) });

    const blocks = [];
    const authBlock = () =>
      blocks.push(
        resBlock(
          "s4xx",
          "401 Unauthorized",
          "Thiếu / sai Bearer token",
          json({ message: sampleMessage(tpl401, model, table.name, table, keys) })
        )
      );

    const kind = sel.value;

    if (kind === "list") {
      const qs = [];
      if (searchCols.length) qs.push("keyword=string");
      if (pagingOn) qs.push("page=1", `pageSize=${pageSize}`);
      const req = `GET /api/${api}${qs.length ? "?" + qs.join("&") : ""}`;
      const body = pagingOn
        ? { total: 1, page: 1, pageSize, items: [obj] }
        : [obj];
      blocks.push(
        cList200
          ? resBlock("s2xx", String(cList200.status), req, customSampleBody(cList200))
          : resBlock("s2xx", "200 OK", req, json(body))
      );
      if (authorize) authBlock();
    }

    if (kind === "detail") {
      const req = `GET /api/${api}/${keyPath}`;
      const cDetail200S = state.customMessages.filter((m) => m.endpoint === "detail" && String(m.status) === "200").pop() || null;
      blocks.push(
        cDetail200S
          ? resBlock("s2xx", String(cDetail200S.status), req, customSampleBody(cDetail200S))
          : resBlock("s2xx", "200 OK", req, json(obj))
      );
      blocks.push(
        resBlock("s4xx", "404 Not Found", req, notFoundDetailBody)
      );
      if (authorize) authBlock();
    }
    if (kind === "create") {
      const req = `POST /api/${api}`;
      const cSuccCreate = state.customMessages.filter((m) => m.endpoint === "create" && m.text && m.text.trim()).pop() || null;
      const createSuccess = cSuccCreate && cSuccCreate.text && cSuccCreate.text.trim();
      blocks.push(
        createSuccess
          ? resBlock("s2xx", String(cSuccCreate.status), req, customSampleBody(cSuccCreate))
          : resBlock("s2xx", "201 Created", req, json(obj), `Location: http://localhost:5002/api/${api}/${keyPath}`)
      );
      blocks.push(resBlock("s4xx", "400 Bad Request", req + " (body sai kiểu / thiếu field)", validationCreateBody));
      if (authorize) authBlock();
    }

    if (kind === "update") {
      const req = `PUT /api/${api}/${keyPath}`;
      const cSuccUpdate = state.customMessages.filter((m) => m.endpoint === "update" && m.text && m.text.trim()).pop() || null;
      const updateSuccess = cSuccUpdate && cSuccUpdate.text && cSuccUpdate.text.trim();
      blocks.push(
        updateSuccess
          ? resBlock("s2xx", String(cSuccUpdate.status), req, customSampleBody(cSuccUpdate))
          : resBlock("s2xx", "204 No Content", req, "(không có body)")
      );
      blocks.push(resBlock("s4xx", "400 Bad Request", req + " (id trên URL ≠ id trong body)", mismatchUpdateBody));
      blocks.push(resBlock("s4xx", "400 Bad Request", req + " (body sai kiểu)", validationUpdateBody));
      if (authorize) authBlock();
    }

    if (kind === "delete") {
      const req = `DELETE /api/${api}/${keyPath}`;
      const cSuccDelete = state.customMessages.filter((m) => m.endpoint === "delete" && m.text && m.text.trim()).pop() || null;
      const deleteSuccess = cSuccDelete && cSuccDelete.text && cSuccDelete.text.trim();
      blocks.push(
        deleteSuccess
          ? resBlock("s2xx", String(cSuccDelete.status), req, customSampleBody(cSuccDelete))
          : resBlock("s2xx", "204 No Content", req, "(không có body)")
      );
      blocks.push(
        resBlock("s4xx", "404 Not Found", req, notFoundDeleteBody)
      );
      if (authorize) authBlock();
    }

    out.innerHTML = blocks.join("");
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // =====================================================================
  // HƯỚNG DẪN NẠP DB & DB-FIRST
  // =====================================================================
  const views = { setup: $("#view-setup"), db: $("#view-schema"), context: $("#view-context"), razor: $("#view-razor"), crud: $("#view-crud"), login: $("#view-login"), linq: $("#view-linq"), odata: $("#view-odata") };
  const viewTitles = { setup: "Nạp DB & DB-first", db: "Cấu trúc bảng", context: "Sinh DbContext", razor: "Sinh Razor CRUD", crud: "Sinh Controller CRUD", login: "Sinh Login", linq: "Cách dùng LINQ", odata: "Sinh Controller OData CRUD" };

  function showView(name) {
    const key = views[name] ? name : "db";
    Object.keys(views).forEach((k) => {
      views[k].hidden = k !== key;
    });
    document.querySelectorAll("#nav .nav-item").forEach((item) => {
      item.classList.toggle("active", item.getAttribute("data-tool") === key);
    });
    $("#crumbTitle").textContent = viewTitles[key];
    document.title = "PRN232 · " + viewTitles[key];
    $("#app").classList.remove("nav-open");

    if (key === "setup") {
      renderConn();
      $("#stats").textContent = "Hướng dẫn: SQL → DB-first → scaffold";
    } else if (key === "context") {
      refreshCtxOptions();
      renderCtx();
      $("#stats").textContent = "Sinh DbContext: chọn bảng → copy code";
    } else if (key === "razor") {
      refreshRazorOptions();
      renderRazor();
      $("#stats").textContent = "Sinh Razor CRUD: chọn bảng → copy code";
    } else if (key === "login") {
      renderLogin();
      $("#stats").textContent = "Sinh Login: copy code";
    } else if (key === "linq") {
      renderLinq();
      $("#stats").textContent = "Cách dùng LINQ: snippet tham khảo";
    } else if (key === "odata") {
      refreshOdataOptions();
      renderOdata();
      $("#stats").textContent = "Sinh Controller OData CRUD: chọn bảng → copy code";
    } else if (key === "crud") {
      refreshGenOptions();
      if (!state.genTable && state.tables.length) setGenTable(state.tables[0]);
      else renderGen();
      $("#stats").textContent = "Sinh CRUD: chọn bảng → copy code";
    } else {
      updateStats();
    }
  }

  // Ghép connection string từ form
  function connInfo() {
    const server = $("#connServer").value.trim() || "localhost";
    const db = $("#connDb").value.trim() || "Prn232Exam";
    const auth = (document.querySelector('input[name="auth"]:checked') || {}).value || "windows";
    const trust = $("#trustCert").checked;
    const user = $("#connUser").value.trim() || "sa";
    const pass = $("#connPass").value;

    let conn = `Server=${server};Database=${db};`;
    if (auth === "windows") conn += "Trusted_Connection=True;";
    else conn += `User Id=${user};Password=${pass};`;
    if (trust) conn += "TrustServerCertificate=True;";

    return { server, db, auth, user, pass, conn };
  }

  function renderConn() {
    const { server, db, auth, user, pass, conn } = connInfo();

    // Hiển thị mỗi tham số 1 dòng cho dễ đọc; dữ liệu copy vẫn là 1 dòng
    const connDisplay = conn.split(";").filter(Boolean).map((p) => p + ";").join("\n");
    $("#outConn").textContent = connDisplay;
    $("#outConn").dataset.raw = conn;

    const json = JSON.stringify({ ConnectionStrings: { MyCnn: conn } }, null, 2);
    $("#outJson").textContent = json;
    $("#outJson").dataset.raw = json;

    const authFlag = auth === "windows" ? "-E" : `-U "${user}" -P "${pass}"`;
    $("#cmdRunSql").textContent = `sqlcmd -S ${server} ${authFlag} -i "script.sql"`;
    $("#cmdCheck").textContent = `sqlcmd -S ${server} ${authFlag} -d ${db} -Q "SELECT name FROM sys.tables ORDER BY name"`;
    $("#cmdInstall").textContent = [
      "dotnet tool install --global dotnet-ef",
      "dotnet add package Microsoft.EntityFrameworkCore.SqlServer",
      "dotnet add package Microsoft.EntityFrameworkCore.Design"
    ].join("\n");
    $("#cmdScaffold").textContent =
      `dotnet ef dbcontext scaffold "${conn}" Microsoft.EntityFrameworkCore.SqlServer -o Models -f --no-onconfiguring`;
    $("#cmdBuild").textContent = [
      "dotnet build src/Prn232.sln",
      "dotnet run --project src/Prn232.AuthApi",
      "dotnet run --project src/Prn232.ProductApi",
      "dotnet run --project src/Prn232.Fe"
    ].join("\n");
  }

  // Clipboard chạy được cả khi mở file:// (fallback execCommand)
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy") ? resolve() : reject(new Error("copy failed"));
      } catch (err) {
        reject(err);
      } finally {
        ta.remove();
      }
    });
  }

  // Vẽ danh sách message tùy chỉnh (thêm qua nút “Thêm message”)
  function renderCustomMsgs() {
    const box = $("#customMsgList");
    if (!box) return;
    if (!state.customMessages.length) {
      box.innerHTML = `<p class="out-hint">Chưa có message tùy chỉnh. Dùng nút “Thêm message” để thêm mới.</p>`;
      return;
    }
    box.innerHTML = state.customMessages
      .map(
        (m) => `
        <div class="msg-custom">
          <select class="input mini" data-cm-id="${m.id}">
            <option value="" disabled>endpoint</option>
            <option value="list" ${m.endpoint === "list" ? "selected" : ""}>List</option>
            <option value="detail" ${m.endpoint === "detail" ? "selected" : ""}>Detail</option>
            <option value="create" ${m.endpoint === "create" ? "selected" : ""}>Create</option>
            <option value="update" ${m.endpoint === "update" ? "selected" : ""}>Update</option>
            <option value="delete" ${m.endpoint === "delete" ? "selected" : ""}>Delete</option>
            <option value="auth" ${m.endpoint === "auth" ? "selected" : ""}>Auth</option>
          </select>
          <select class="input mini" data-cm-status="${m.id}">
            <option value="200" ${String(m.status) === "200" ? "selected" : ""}>200</option>
            <option value="201" ${String(m.status) === "201" ? "selected" : ""}>201</option>
            <option value="204" ${String(m.status) === "204" ? "selected" : ""}>204</option>
            <option value="400" ${String(m.status) === "400" ? "selected" : ""}>400</option>
            <option value="401" ${String(m.status) === "401" ? "selected" : ""}>401</option>
            <option value="403" ${String(m.status) === "403" ? "selected" : ""}>403</option>
            <option value="404" ${String(m.status) === "404" ? "selected" : ""}>404</option>
          </select>
          <input class="input" data-cm-id="${m.id}" data-cm-text value="${esc(m.text)}" placeholder="Nội dung message..." />
          <button type="button" class="btn ghost sm" data-cm-del="${m.id}">Xoá</button>
        </div>`
      )
      .join("");
  }

  // =====================================================================
  // GẮN SỰ KIỆN
  // =====================================================================
  const dropzone = $("#dropzone");
  const fileInput = $("#fileInput");

  fileInput.addEventListener("change", () => {
    readFile(fileInput.files && fileInput.files[0]);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    readFile(file);
  });
  // Chặn browser mở file khi kéo vào chỗ khác
  ["dragover", "drop"].forEach((evt) =>
    document.addEventListener(evt, (e) => e.preventDefault())
  );

  $("#btnAnalyze").addEventListener("click", analyze);

  $("#btnSample").addEventListener("click", () => {
    $("#sqlInput").value = SAMPLE_SQL;
    $("#fileMeta").textContent = "Ví dụ";
    $("#fileName").hidden = true;
    analyze();
  });

  $("#btnClear").addEventListener("click", () => {
    clearAll();
    toast("Đã xoá nội dung.", "info");
  });

  $("#searchInput").addEventListener("input", (e) => {
    state.query = e.target.value;
    applyFilter();
  });

  $("#btnExpand").addEventListener("click", () => {
    document.querySelectorAll("#tableList .tbl").forEach((el) => (el.open = true));
  });

  $("#btnCollapse").addEventListener("click", () => {
    document.querySelectorAll("#tableList .tbl").forEach((el) => (el.open = false));
  });

  // Bấm "Sinh CRUD" trên card bảng -> mở generator
  $("#tableList").addEventListener("click", (e) => {
    const genBtn = e.target.closest(".tbl-action");
    if (!genBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const table = state.tables.find((t) => t.name === genBtn.getAttribute("data-gen"));
    if (!table) return;
    setGenTable(table);
    showView("crud");
    toast(`Đã chuyển bảng ${table.name} sang trang sinh CRUD.`, "ok");
  });

  // Bấm chip khóa ngoại -> nhảy tới bảng liên quan
  $("#tableList").addEventListener("click", (e) => {
    const link = e.target.closest(".fk-link");
    if (!link) return;
    const target = document.getElementById(link.getAttribute("data-target"));
    if (!target) return;
    target.hidden = false;
    target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("flash");
    void target.offsetWidth; // restart animation
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1400);
  });

  // Sidebar: đổi tool
  $("#nav").addEventListener("click", (e) => {
    const item = e.target.closest(".nav-item");
    if (!item) return;
    const tool = item.getAttribute("data-tool");
    if (tool === "setup" || tool === "db" || tool === "crud" || tool === "context" || tool === "razor" || tool === "login" || tool === "linq" || tool === "odata") {
      showView(tool);
      return;
    }
    toast("“" + item.querySelector(".label").textContent.trim() + "” sẽ có ở bước tiếp theo.", "info");
  });

  // Form kết nối: cập nhật lệnh ngay khi sửa
  ["connServer", "connDb", "connUser", "connPass"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderConn);
  });
  document.querySelectorAll('input[name="auth"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const useSql = document.querySelector('input[name="auth"]:checked').value === "sql";
      $("#sqlAuthFields").hidden = !useSql;
      renderConn();
    });
  });
  $("#trustCert").addEventListener("change", renderConn);
  $("#btnGoSchema").addEventListener("click", () => showView("db"));

  // Sinh Controller CRUD
  $("#cmdGenInstall").textContent = [
    "dotnet tool install --global dotnet-aspnet-codegenerator",
    "dotnet add package Microsoft.VisualStudio.Web.CodeGeneration.Design",
    "dotnet add package Microsoft.EntityFrameworkCore.Design"
  ].join("\n");

  $("#genTable").addEventListener("change", (e) => {
    const name = e.target.value;
    const pool = state.tables.concat(state.genTable ? [state.genTable] : []);
    const table = pool.find((t) => t.name === name);
    if (table) setGenTable(table);
  });

  ["genController", "genContext", "genNamespace", "genModelNs"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderGen);
  });
  $("#genAuthorize").addEventListener("change", renderGen);

  // Tick/bỏ action -> bật tắt search/sort + sinh lại code
  document.querySelectorAll(".gen-act").forEach((cb) => {
    cb.addEventListener("change", () => {
      syncGenDisabled();
      renderGen();
    });
  });
  $("#genSearchFields").addEventListener("change", renderGen);
  $("#genPaging").addEventListener("change", () => {
    syncGenDisabled();
    renderGen();
  });
  $("#genPageSize").addEventListener("input", renderGen);
  const MSG_STATE_KEYS = {
    msgNotFound: "notFound",
    msgMismatch: "mismatch",
    msgValidation: "validation",
    msgUnauthorized: "unauthorized",
    msgForbidden: "forbidden"
  };
  Object.keys(MSG_STATE_KEYS).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      state.messages[MSG_STATE_KEYS[id]] = el.value;
      renderGen();
      renderSample();
    });
  });
  // Message tùy chỉnh: thêm mới / sửa / xoá
  $("#btnAddMsg").addEventListener("click", () => {
    state.customMessages.push({ id: Date.now(), endpoint: "create", status: "201", text: "" });
    renderCustomMsgs();
    renderGen();
    renderSample();
  });
  $("#customMsgList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-cm-del]");
    if (!del) return;
    const id = Number(del.getAttribute("data-cm-del"));
    state.customMessages = state.customMessages.filter((m) => m.id !== id);
    renderCustomMsgs();
    renderGen();
    renderSample();
  });
  $("#customMsgList").addEventListener("change", (e) => {
    const epEl = e.target.closest("[data-cm-endpoint]");
    const stEl = e.target.closest("[data-cm-status]");
    const id = stEl ? Number(stEl.getAttribute("data-cm-status")) : epEl ? Number(epEl.getAttribute("data-cm-id")) : NaN;
    const m = state.customMessages.find((x) => x.id === id);
    if (!m) return;
    if (epEl) m.endpoint = epEl.value;
    if (stEl) m.status = stEl.value;
    renderCustomMsgs();
    renderGen();
    renderSample();
  });
  $("#customMsgList").addEventListener("input", (e) => {
    const textEl = e.target.closest("[data-cm-text]");
    if (!textEl) return;
    const id = Number(textEl.getAttribute("data-cm-id"));
    const m = state.customMessages.find((x) => x.id === id);
    if (m) {
      m.text = textEl.value;
      renderGen();
      renderSample();
    }
  });
  $("#sampleEndpoint").addEventListener("change", renderSample);
  $("#btnSampleResult").addEventListener("click", renderSample);
  $("#genSortFields").addEventListener("change", (e) => {
    if (e.target.classList.contains("gen-sort")) syncGenDisabled();
    renderGen();
  });

  $("#btnUsePaste").addEventListener("click", () => {
    const raw = $("#genPaste").value.trim();
    if (!raw) return toast("Chưa có nội dung để dùng.", "err");

    let table = null;
    if (/create\s+table/i.test(raw)) {
      const parsed = parseSql(raw);
      table = parsed.tables[0] || null;
    } else {
      const name = raw.replace(/[\[\]"]/g, "").split(".").pop().trim();
      table = state.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
    }

    if (!table) {
      return toast("Không tìm thấy bảng từ nội dung đã dán.", "err");
    }
    setGenTable(table);
    toast(`Đã chọn bảng ${table.name}.`, "ok");
  });

  $("#btnDownloadCs").addEventListener("click", () => {
    if (!state.genCode) return toast("Chưa có code để tải.", "err");
    const name = ($("#genController").value.trim() || "Controller").replace(/\.cs$/i, "") + ".cs";
    download(new Blob([state.genCode], { type: "text/plain;charset=utf-8" }), name);
  });

  // Sinh DbContext
  $("#ctxChecks").addEventListener("change", (e) => {
    if (e.target.classList.contains("ctx-check")) renderCtx();
  });
  ["ctxContext", "ctxNamespace"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderCtx);
  });
  $("#btnCtxUsePaste").addEventListener("click", () => {
    const raw = $("#ctxPaste").value.trim();
    if (!raw) return toast("Chưa có nội dung để dùng.", "err");

    let table = null;
    if (/create\s+table/i.test(raw)) {
      const parsed = parseSql(raw);
      table = parsed.tables[0] || null;
    } else {
      const name = raw.replace(/[\[\]"]/g, "").split(".").pop().trim();
      const pool = ctxTablePool();
      table = pool.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
    }

    if (!table) return toast("Không tìm thấy bảng từ nội dung đã dán.", "err");
    setCtxCheck(table.name, true);
    renderCtx();
    toast(`Đã chọn bảng ${table.name}.`, "ok");
  });
  $("#btnDownloadCtx").addEventListener("click", () => {
    if (!state.ctxCode) return toast("Chọn bảng để sinh DbContext trước.", "err");
    const name = ($("#ctxContext").value.trim() || "Prn232Context").replace(/\.cs$/i, "") + ".cs";
    download(new Blob([state.ctxCode], { type: "text/plain;charset=utf-8" }), name);
  });

  // Sinh Razor CRUD
  $("#razorTable").addEventListener("change", (e) => {
    const t = ctxTablePool().find((x) => x.name === e.target.value);
    setRazorTable(t || null);
  });
  $("#btnRazorUsePaste").addEventListener("click", () => {
    const raw = $("#razorPaste").value.trim();
    if (!raw) return toast("Chưa có nội dung để dùng.", "err");

    let table = null;
    if (/create\s+table/i.test(raw)) {
      const parsed = parseSql(raw);
      table = parsed.tables[0] || null;
    } else {
      const name = raw.replace(/[\[\]"]/g, "").split(".").pop().trim();
      const pool = ctxTablePool();
      table = pool.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
    }

    if (!table) return toast("Không tìm thấy bảng từ nội dung đã dán.", "err");
    setRazorTable(table);
    toast(`Đã chọn bảng ${table.name}.`, "ok");
  });
  $("#btnDownloadRazor").addEventListener("click", () => {
    if (!state.razorCode) return toast("Chọn bảng để sinh Razor Page trước.", "err");
    download(new Blob([state.razorCode], { type: "text/plain;charset=utf-8" }), "Index.cshtml");
  });
  $("#btnDownloadRazorCs").addEventListener("click", () => {
    if (!state.razorCs) return toast("Chọn bảng để sinh Razor Page trước.", "err");
    download(new Blob([state.razorCs], { type: "text/plain;charset=utf-8" }), "Index.cshtml.cs");
  });

  // Sinh Login
  $("#btnDownloadLogin").addEventListener("click", () => {
    if (!state.loginCode) return toast("Sinh Login trước.", "err");
    download(new Blob([state.loginCode], { type: "text/plain;charset=utf-8" }), "Login.cshtml");
  });
  $("#btnDownloadLoginCs").addEventListener("click", () => {
    if (!state.loginCs) return toast("Sinh Login trước.", "err");
    download(new Blob([state.loginCs], { type: "text/plain;charset=utf-8" }), "Login.cshtml.cs");
  });
  $("#btnDownloadLoginApi").addEventListener("click", () => {
    if (!state.loginApiCode) return toast("Sinh Login trước.", "err");
    download(new Blob([state.loginApiCode], { type: "text/plain;charset=utf-8" }), "AuthController.cs");
  });
  $("#btnDownloadLinq").addEventListener("click", () => {
    if (!state.linqCode) return toast("Sinh snippet LINQ trước.", "err");
    download(new Blob([state.linqCode], { type: "text/plain;charset=utf-8" }), "LinqSnippet.cs");
  });
  $("#btnDownloadOdata").addEventListener("click", () => {
    if (!state.odataCode) return toast("Chọn bảng để sinh controller OData CRUD trước.", "err");
    const name = ($("#genController").value.trim() || "Controller").replace(/\.cs$/i, "") + ".cs";
    download(new Blob([state.odataCode], { type: "text/plain;charset=utf-8" }), name);
  });
  $("#btnDownloadOdataProgram").addEventListener("click", () => {
    const code = $("#odataProgramCode").textContent;
    if (!code || code.indexOf("AddOData") === -1) return toast("Chọn bảng để sinh code OData trước.", "err");
    download(new Blob([code], { type: "text/plain;charset=utf-8" }), "Program.cs");
  });

  // Nút sao chép trong trang hướng dẫn
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const src = document.getElementById(btn.getAttribute("data-copy"));
    if (!src) return;
    const raw = src.dataset.raw != null ? src.dataset.raw : src.textContent;
    try {
      await copyText(raw);
      const old = btn.textContent;
      btn.textContent = "Đã chép";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = old;
        btn.classList.remove("copied");
      }, 1500);
    } catch (err) {
      toast("Không sao chép được.", "err");
    }
  });

  $("#navToggle").addEventListener("click", () => $("#app").classList.toggle("nav-open"));
  document.addEventListener("click", (e) => {
    if (window.innerWidth > 980) return;
    if (e.target.closest(".sidebar") || e.target.closest("#navToggle")) return;
    $("#app").classList.remove("nav-open");
  });

  // Báo lỗi rõ ràng nếu script chết giữa chừng
  window.addEventListener("error", (e) => {
    if (e && e.message) toast("Lỗi: " + e.message, "err");
  });

  // =====================================================================
  // DỮ LIỆU MẪU
  // =====================================================================
  const SAMPLE_SQL = `CREATE TABLE [dbo].[Account] (
  [Id]       INT IDENTITY(1,1) PRIMARY KEY,
  [Username] NVARCHAR(50)  NOT NULL UNIQUE,
  [Password] NVARCHAR(100) NOT NULL,
  [Role]     NVARCHAR(20)  NOT NULL DEFAULT 'User',
  CONSTRAINT [CK_Account_Role] CHECK ([Role] IN ('Admin', 'User'))
);

CREATE TABLE [dbo].[Category] (
  [Id]   INT IDENTITY(1,1) PRIMARY KEY,
  [Name] NVARCHAR(100) NOT NULL
);

CREATE TABLE [dbo].[Product] (
  [Id]         INT IDENTITY(1,1) PRIMARY KEY,
  [Name]       NVARCHAR(150)  NOT NULL,
  [Price]      DECIMAL(18,2)  NOT NULL CHECK ([Price] >= 0),
  [Stock]      INT            NOT NULL DEFAULT 0,
  [CreatedAt]  DATETIME2      NOT NULL DEFAULT GETDATE(),
  [CategoryId] INT            NOT NULL,
  CONSTRAINT [FK_Product_Category] FOREIGN KEY ([CategoryId])
    REFERENCES [dbo].[Category]([Id])
);

CREATE TABLE [dbo].[Order] (
  [Id]        INT IDENTITY(1,1) PRIMARY KEY,
  [AccountId] INT           NOT NULL,
  [Total]     DECIMAL(18,2) NOT NULL,
  CONSTRAINT [FK_Order_Account] FOREIGN KEY ([AccountId]) REFERENCES [dbo].[Account]([Id])
);`;

  showView("setup");
})();

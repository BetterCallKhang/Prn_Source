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
  const state = {
    tables: [],
    relations: [],
    ids: new Map(), // tên bảng -> id DOM
    query: "",
    genTable: null,
    genCode: ""
  };

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

    const msg404 = csMessage($("#msgNotFound").value, model, table.name, keys);
    const msgMismatch = csMessage($("#msgMismatch").value, model, table.name, keys);
    const msg401 = csLiteral($("#msgUnauthorized").value, model, table.name);
    const msg403 = csLiteral($("#msgForbidden").value, model, table.name);

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
      if (pagingOn) {
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
      L.push(`            return NotFound(new { message = ${msg404} });`);
      L.push("        return Ok(item);");
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
      L.push("            return BadRequest(ModelState);");
      L.push("");
      L.push(`        _context.Set<${model}>().Add(model);`);
      L.push("        await _context.SaveChangesAsync();");
      L.push("");
      if (acts.detail) {
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
      L.push(`            return BadRequest(new { message = ${msgMismatch} });`);
      L.push("        if (!ModelState.IsValid)");
      L.push("            return BadRequest(ModelState);");
      L.push("");
      L.push(`        _context.Set<${model}>().Update(model);`);
      L.push("        try");
      L.push("        {");
      L.push("            await _context.SaveChangesAsync();");
      L.push("        }");
      L.push("        catch (DbUpdateConcurrencyException)");
      L.push("        {");
      L.push(`            if (!await _context.Set<${model}>().AnyAsync(e => ${anyExpr}))`);
      L.push(`                return NotFound(new { message = ${msg404} });`);
      L.push("            throw;");
      L.push("        }");
      L.push("        return NoContent();");
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
      L.push(`            return NotFound(new { message = ${msg404} });`);
      L.push("");
      L.push(`        _context.Set<${model}>().Remove(item);`);
      L.push("        await _context.SaveChangesAsync();");
      L.push("        return NoContent();");
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

  // =====================================================================
  // KẾT QUẢ MẪU CỦA ENDPOINT
  // =====================================================================
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

  const SAMPLE_VALIDATION = {
    type: "https://tools.ietf.org/html/rfc9110#section-15.5.1",
    title: "One or more validation errors occurred.",
    status: 400,
    errors: { price: ['The JSON value could not be converted to System.Decimal.'] }
  };

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

    const tpl404 = $("#msgNotFound").value;
    const tplMismatch = $("#msgMismatch").value;
    const tpl401 = $("#msgUnauthorized").value;
    const notFoundBody = json({ message: sampleMessage(tpl404, model, table.name, table, keys) });

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
      blocks.push(resBlock("s2xx", "200 OK", req, json(body)));
      if (authorize) authBlock();
    }

    if (kind === "detail") {
      const req = `GET /api/${api}/${keyPath}`;
      blocks.push(resBlock("s2xx", "200 OK", req, json(obj)));
      blocks.push(
        resBlock("s4xx", "404 Not Found", req, notFoundBody)
      );
      if (authorize) authBlock();
    }

    if (kind === "create") {
      const req = `POST /api/${api}`;
      blocks.push(
        resBlock("s2xx", "201 Created", req, json(obj), `Location: http://localhost:5002/api/${api}/${keyPath}`)
      );
      blocks.push(resBlock("s4xx", "400 Bad Request", req + " (body sai kiểu / thiếu field)", json(SAMPLE_VALIDATION)));
      if (authorize) authBlock();
    }

    if (kind === "update") {
      const req = `PUT /api/${api}/${keyPath}`;
      blocks.push(resBlock("s2xx", "204 No Content", req, "(không có body)"));
      blocks.push(
        resBlock("s4xx", "400 Bad Request", req + " (id trên URL ≠ id trong body)", json({ message: sampleMessage(tplMismatch, model, table.name, table, keys) }))
      );
      blocks.push(resBlock("s4xx", "400 Bad Request", req + " (body sai kiểu)", json(SAMPLE_VALIDATION)));
      if (authorize) authBlock();
    }

    if (kind === "delete") {
      const req = `DELETE /api/${api}/${keyPath}`;
      blocks.push(resBlock("s2xx", "204 No Content", req, "(không có body)"));
      blocks.push(
        resBlock("s4xx", "404 Not Found", req, notFoundBody)
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
  const views = { setup: $("#view-setup"), db: $("#view-schema"), crud: $("#view-crud") };
  const viewTitles = { setup: "Nạp DB & DB-first", db: "Cấu trúc bảng", crud: "Sinh Controller CRUD" };

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
    if (tool === "setup" || tool === "db" || tool === "crud") {
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
  ["msgNotFound", "msgMismatch", "msgUnauthorized", "msgForbidden"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderGen);
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

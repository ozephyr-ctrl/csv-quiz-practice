import { Question } from "./types";

/**
 * 编译产物（.cqv）编解码：简化二进制分发格式。
 *
 * 家族魔数固定为 "CQV1"（不随 formatVersion 变化），由头部 formatVersion 区分布局。
 *
 * 公共固定头（20B，两种版本一致）：
 *   offset 0:  [魔数 "CQV1" 4B]
 *   offset 4:  [uint32 headerLen]        // 从文件头到逐行数据开始前的字节数
 *   offset 8:  [uint32 formatVersion]    // 1 或 2
 *   offset 12: [uint32 questionCount]    // **原始行数**（未展开为卡片）
 *   offset 16: [uint32 generatedAt]      // unix 秒
 *
 * v1 布局（保持历史兼容，逐行 12 字段）：
 *   offset 20: [uint32 sourceCsvLen][sourceCsv UTF-8 字节]
 *   之后:       [uint32 noteLen][note UTF-8 字节]  // 可为空（len=0）
 *   之后:       逐行数据（questionCount 行，每行固定 12 个字符串字段）：
 *                id | stem | optionA | optionB | optionC | optionD | answer
 *                | tags | category1 | category2 | category3 | repeat
 *                每字段：[uint32 字节长度 L][UTF-8 字节 ×L]
 *
 * v2 布局（逐行 14 字段，新增 kind/direction；不再展开，保留原始行）：
 *   offset 20: [uint32 sourceFileCount]
 *              每项: [uint32 len][UTF-8 字节]  // 有序源路径数组
 *   之后:       [uint32 noteLen][note UTF-8 字节]
 *   之后:       逐行数据（questionCount 行，每行固定 14 个字符串字段）：
 *                id | stem | optionA | optionB | optionC | optionD | answer
 *                | tags | category1 | category2 | category3 | repeat
 *                | kind | direction
 *                每字段：[uint32 字节长度 L][UTF-8 字节 ×L]
 *
 * 全部多字节整数为 little-endian（DataView getUint32/setUint32，true）。
 * 文本编码 UTF-8（TextEncoder/TextDecoder）。
 *
 * 注意：CQV 只负责存储**原始行**，不做简答题展开、不做 id 质量校验、不做题型校验。
 * 加载方需自行调用 expandShortAnswerRows 展开简答题，并统一做质量校验。
 */

/** 产物头部元信息。 */
export interface CqvHeader {
  formatVersion: number;
  /** 原始行数（未展开为卡片）。 */
  questionCount: number;
  generatedAt: number; // unix 秒
  /** v1：单一源 CSV 路径；v2：取 sourceFiles[0]（无则 ""）。 */
  sourceCsv: string;
  /** 有序源路径数组（v2 才有；v1 解码时设为 [sourceCsv]）。 */
  sourceFiles?: string[];
  note: string;
}

/**
 * 解码结果：头部 + 题目。
 * `questions` 语义为**原始行**（可能包含未展开的简答题行）；调用方需自行用
 * expandShortAnswerRows 展开。favorite/mastered/wrong 为 C 类字段，不进产物，默认为空串。
 */
export interface CqvResult {
  header: CqvHeader;
  questions: Question[];
}

const CQV_MAGIC = "CQV1";
/** 固定头部字节数：魔数4 + 头部长度4 + formatVersion4 + questionCount4 + generatedAt4。 */
const FIXED_HEADER_BYTES = 20;
/** v1 每行固定字段数。 */
const FIELDS_PER_QUESTION_V1 = 12;
/** v2 每行固定字段数（含 kind/direction）。 */
const FIELDS_PER_QUESTION_V2 = 14;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** 编码：questions → ArrayBuffer（.cqv 文件内容）。不校验 id 质量（由调用方负责）。 */
export function encodeCqv(
  questions: Question[],
  opts: {
    sourceCsv: string;
    sourceFiles?: string[];
    note: string;
    generatedAt?: number;
    formatVersion?: 1 | 2;
  }
): ArrayBuffer {
  const formatVersion = opts.formatVersion ?? 1;
  const noteBytes = encoder.encode(opts.note);
  const sourceCsvBytes = encoder.encode(opts.sourceCsv);

  // v2：源路径数组（空/缺省回退为 [sourceCsv]）；v1 不写。
  const sourceFileBytes: Uint8Array[] =
    formatVersion === 2
      ? (opts.sourceFiles && opts.sourceFiles.length > 0
          ? opts.sourceFiles
          : [opts.sourceCsv]
        ).map((f) => encoder.encode(f))
      : [];

  let headerLen = FIXED_HEADER_BYTES;
  if (formatVersion === 1) {
    headerLen += 4 + sourceCsvBytes.length;
  } else {
    headerLen += 4; // sourceFileCount
    for (const f of sourceFileBytes) headerLen += 4 + f.length;
  }
  headerLen += 4 + noteBytes.length;

  // 预编码所有字段，先算总长度再分配缓冲区
  const fieldValues: Uint8Array[][] = questions.map((q) => {
    const fields = [
      encoder.encode(q.id),
      encoder.encode(q.stem),
      encoder.encode(q.optionA),
      encoder.encode(q.optionB),
      encoder.encode(q.optionC),
      encoder.encode(q.optionD),
      encoder.encode(q.answer),
      encoder.encode(q.tags),
      encoder.encode(q.category1),
      encoder.encode(q.category2),
      encoder.encode(q.category3),
      encoder.encode(q.repeat),
    ];
    if (formatVersion === 2) {
      fields.push(encoder.encode(q.kind ?? "choice"));
      fields.push(encoder.encode(q.direction ?? ""));
    }
    return fields;
  });

  let dataBytes = 0;
  for (const fields of fieldValues) {
    for (const f of fields) {
      dataBytes += 4 + f.length;
    }
  }

  const buffer = new ArrayBuffer(headerLen + dataBytes);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // 魔数
  for (let i = 0; i < 4; i++) {
    u8[i] = CQV_MAGIC.charCodeAt(i);
  }
  let offset = 4;
  view.setUint32(offset, headerLen, true);
  offset += 4;
  view.setUint32(offset, formatVersion, true);
  offset += 4;
  view.setUint32(offset, questions.length, true); // 原始行数
  offset += 4;
  view.setUint32(offset, opts.generatedAt ?? Math.floor(Date.now() / 1000), true);
  offset += 4;

  if (formatVersion === 1) {
    view.setUint32(offset, sourceCsvBytes.length, true);
    offset += 4;
    u8.set(sourceCsvBytes, offset);
    offset += sourceCsvBytes.length;
  } else {
    view.setUint32(offset, sourceFileBytes.length, true);
    offset += 4;
    for (const f of sourceFileBytes) {
      view.setUint32(offset, f.length, true);
      offset += 4;
      u8.set(f, offset);
      offset += f.length;
    }
  }

  view.setUint32(offset, noteBytes.length, true);
  offset += 4;
  u8.set(noteBytes, offset);
  offset += noteBytes.length;

  // 逐行
  for (const fields of fieldValues) {
    for (const f of fields) {
      view.setUint32(offset, f.length, true);
      offset += 4;
      u8.set(f, offset);
      offset += f.length;
    }
  }

  return buffer;
}

/** 读取一个 [uint32 len][UTF-8 bytes] 字段，越界抛错。返回文本与推进后的偏移。 */
function readField(
  view: DataView,
  u8: Uint8Array,
  offset: number,
  byteLength: number
): { value: string; offset: number } {
  if (offset + 4 > byteLength) {
    throw new Error("产物数据截断或损坏");
  }
  const len = view.getUint32(offset, true);
  offset += 4;
  if (offset + len > byteLength) {
    throw new Error("产物数据截断或损坏");
  }
  const value = decoder.decode(u8.subarray(offset, offset + len));
  return { value, offset: offset + len };
}

/**
 * 解码：ArrayBuffer → CqvResult。含多重解析防御，失败抛 Error（中文消息）。
 * 空 id 不在此拒绝（长度防御以外交由调用方统一处理）。
 */
export function decodeCqv(buffer: ArrayBuffer): CqvResult {
  if (buffer.byteLength < FIXED_HEADER_BYTES) {
    throw new Error("文件过短，不是有效的题库产物");
  }
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // 防御1：魔数
  for (let i = 0; i < 4; i++) {
    if (u8[i] !== CQV_MAGIC.charCodeAt(i)) {
      throw new Error("不是有效的题库产物（魔数不匹配）");
    }
  }
  let offset = 4;
  const headerLen = view.getUint32(offset, true);
  offset += 4;
  const formatVersion = view.getUint32(offset, true);
  offset += 4;
  const questionCount = view.getUint32(offset, true);
  offset += 4;
  const generatedAt = view.getUint32(offset, true);
  offset += 4;

  // 防御2：版本
  if (formatVersion !== 1 && formatVersion !== 2) {
    throw new Error("不支持的产物版本");
  }

  let sourceFiles: string[];
  let sourceCsv: string;
  let fieldsPerQuestion: number;

  if (formatVersion === 1) {
    const src = readField(view, u8, offset, buffer.byteLength);
    sourceCsv = src.value;
    offset = src.offset;
    sourceFiles = [sourceCsv];
    fieldsPerQuestion = FIELDS_PER_QUESTION_V1;
  } else {
    // 防御3：sourceFileCount 超大（防内存暴涨）——每项至少 4 字节长度前缀
    if (offset + 4 > buffer.byteLength) {
      throw new Error("产物数据截断或损坏");
    }
    const sourceFileCount = view.getUint32(offset, true);
    offset += 4;
    if (sourceFileCount * 4 > buffer.byteLength - offset) {
      throw new Error("产物数据截断或损坏");
    }
    sourceFiles = [];
    for (let i = 0; i < sourceFileCount; i++) {
      const f = readField(view, u8, offset, buffer.byteLength);
      sourceFiles.push(f.value);
      offset = f.offset;
    }
    sourceCsv = sourceFiles.length > 0 ? sourceFiles[0] : "";
    fieldsPerQuestion = FIELDS_PER_QUESTION_V2;
  }

  const noteField = readField(view, u8, offset, buffer.byteLength);
  const note = noteField.value;
  offset = noteField.offset;

  // 防御4：headerLen 必须精确覆盖到逐行数据开始前
  if (headerLen !== offset) {
    throw new Error("产物头部结构异常");
  }

  // 防御5：questionCount 超大（防内存暴涨）——每字段至少 4 字节长度前缀
  if (
    questionCount > 0 &&
    questionCount * fieldsPerQuestion * 4 > buffer.byteLength - offset
  ) {
    throw new Error("产物数据截断或损坏");
  }

  const questions: Question[] = [];
  for (let i = 0; i < questionCount; i++) {
    const fields: string[] = [];
    for (let f = 0; f < fieldsPerQuestion; f++) {
      const field = readField(view, u8, offset, buffer.byteLength);
      fields.push(field.value);
      offset = field.offset;
    }
    const [
      id,
      stem,
      optionA,
      optionB,
      optionC,
      optionD,
      answer,
      tags,
      category1,
      category2,
      category3,
      repeat,
    ] = fields;

    let kind: "choice" | "short" = "choice";
    let direction: ">" | "<" | "<>" = ">";
    if (formatVersion === 2) {
      const rawKind = fields[12];
      if (rawKind !== "choice" && rawKind !== "short") {
        throw new Error(`产物题型非法：${JSON.stringify(rawKind)}（只支持 choice、short）`);
      }
      kind = rawKind;
      const rawDirection = fields[13].trim();
      if (rawDirection === "" || rawDirection === ">") {
        direction = ">";
      } else if (rawDirection === "<") {
        direction = "<";
      } else if (rawDirection === "<>") {
        direction = "<>";
      } else {
        throw new Error(
          `产物简答题方向非法：${JSON.stringify(fields[13])}（只支持 >、<、<> 或留空）`
        );
      }
    }

    questions.push({
      id,
      stem,
      optionA,
      optionB,
      optionC,
      optionD,
      answer,
      tags,
      category1,
      category2,
      category3,
      repeat,
      kind,
      direction,
      // C 类字段（favorite/mastered/wrong）不入产物，默认空串，由 sidecar meta 覆盖
      favorite: "",
      mastered: "",
      wrong: "",
    });
  }

  return {
    header: {
      formatVersion,
      questionCount,
      generatedAt,
      sourceCsv,
      sourceFiles,
      note,
    },
    questions,
  };
}

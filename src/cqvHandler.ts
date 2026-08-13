import { Question } from "./types";

/**
 * 编译产物（.cqv）编解码：简化二进制分发格式。
 * 编码布局（v1）：
 *   offset 0:  [魔数 "CQV1" 4B]
 *   offset 4:  [uint32 头部长度]        // 从文件头到逐题数据开始的字节数
 *   offset 8:  [uint32 formatVersion = 1]
 *   offset 12: [uint32 questionCount]
 *   offset 16: [uint32 generatedAt]     // unix 秒
 *   offset 20: [uint32 sourceCsvLen][sourceCsv UTF-8 字节]
 *   之后:       [uint32 noteLen][note UTF-8 字节]  // 可为空（len=0）
 *   之后:       逐题数据（questionCount 题，每题目固定 12 个字符串字段）：
 *                id | stem | optionA | optionB | optionC | optionD | answer
 *                | tags | category1 | category2 | category3 | repeat
 *                每字段：[uint32 字节长度 L][UTF-8 字节 ×L]
 * 全部多字节整数为 little-endian（DataView getUint32/setUint32，true）。
 * 文本编码 UTF-8（TextEncoder/TextDecoder）。
 */

/** 产物头部元信息。 */
export interface CqvHeader {
  formatVersion: number;
  questionCount: number;
  generatedAt: number; // unix 秒
  sourceCsv: string;
  note: string;
}

/** 解码结果：头部 + 题目（12 字段；favorite/mastered/wrong 为 C 类，不进产物，默认为空串）。 */
export interface CqvResult {
  header: CqvHeader;
  questions: Question[];
}

const CQV_MAGIC = "CQV1";
/** 固定头部字节数：魔数4 + 头部长度4 + formatVersion4 + questionCount4 + generatedAt4。 */
const FIXED_HEADER_BYTES = 20;
/** 每题目固定字段数。 */
const FIELDS_PER_QUESTION = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * 编码：questions → ArrayBuffer（.cqv 文件内容）。不校验 id 质量（由调用方负责）。
 */
export function encodeCqv(
  questions: Question[],
  opts: { sourceCsv: string; note: string; generatedAt?: number }
): ArrayBuffer {
  const sourceCsvBytes = encoder.encode(opts.sourceCsv);
  const noteBytes = encoder.encode(opts.note);
  const headerLen =
    FIXED_HEADER_BYTES + 4 + sourceCsvBytes.length + 4 + noteBytes.length;

  // 预编码所有字段，先算总长度再分配缓冲区
  const fieldValues: Uint8Array[][] = questions.map((q) => [
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
  ]);

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
  view.setUint32(offset, 1, true); // formatVersion
  offset += 4;
  view.setUint32(offset, questions.length, true);
  offset += 4;
  view.setUint32(offset, opts.generatedAt ?? Math.floor(Date.now() / 1000), true);
  offset += 4;
  view.setUint32(offset, sourceCsvBytes.length, true);
  offset += 4;
  u8.set(sourceCsvBytes, offset);
  offset += sourceCsvBytes.length;
  view.setUint32(offset, noteBytes.length, true);
  offset += 4;
  u8.set(noteBytes, offset);
  offset += noteBytes.length;

  // 逐题
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

/**
 * 解码：ArrayBuffer → CqvResult。含四重解析防御，失败抛 Error（中文消息）。
 * 空 id 不在此拒绝（长度防御以外交由调用方 checkIdQuality 统一处理）。
 */
export function decodeCqv(buffer: ArrayBuffer): CqvResult {
  if (buffer.byteLength < FIXED_HEADER_BYTES) {
    throw new Error("文件过短，不是有效的题库产物");
  }
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // 防御2：魔数
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

  if (formatVersion !== 1) {
    throw new Error("不支持的产物版本");
  }
  if (offset + 4 > buffer.byteLength) {
    throw new Error("文件过短，不是有效的题库产物");
  }
  const sourceCsvLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + sourceCsvLen + 4 > buffer.byteLength) {
    throw new Error("产物数据截断或损坏");
  }
  const sourceCsv = decoder.decode(u8.subarray(offset, offset + sourceCsvLen));
  offset += sourceCsvLen;

  const noteLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + noteLen > buffer.byteLength) {
    throw new Error("产物数据截断或损坏");
  }
  const note = decoder.decode(u8.subarray(offset, offset + noteLen));
  offset += noteLen;

  // 防御3：头部长度必须与固定结构一致（当前版本）
  if (
    headerLen !==
    FIXED_HEADER_BYTES + 4 + sourceCsvLen + 4 + noteLen
  ) {
    throw new Error("产物头部结构异常");
  }

  // 防御4a：questionCount 超大（防内存暴涨）——每字段至少 4 字节长度前缀
  if (
    questionCount > 0 &&
    questionCount * FIELDS_PER_QUESTION * 4 > buffer.byteLength - offset
  ) {
    throw new Error("产物数据截断或损坏");
  }

  const questions: Question[] = [];
  for (let i = 0; i < questionCount; i++) {
    const fields: string[] = [];
    for (let f = 0; f < FIELDS_PER_QUESTION; f++) {
      if (offset + 4 > buffer.byteLength) {
        throw new Error("产物数据截断或损坏");
      }
      const len = view.getUint32(offset, true);
      offset += 4;
      if (offset + len > buffer.byteLength) {
        throw new Error("产物数据截断或损坏");
      }
      fields.push(decoder.decode(u8.subarray(offset, offset + len)));
      offset += len;
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
      note,
    },
    questions,
  };
}

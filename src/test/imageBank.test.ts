import { describe, it, expect } from "vitest";
import {
  buildImageQuestions,
  imageAnswerFromPath,
  imageRatingLabel,
  isImageQuestion,
  isImageRatingKey,
  IMAGE_RATING_LABELS,
} from "../imageBank";

describe("buildImageQuestions", () => {
  it("支持 png/jpg/jpeg/webp/gif/bmp，忽略 txt/svg/avif", () => {
    const files = [
      "img/a.png",
      "img/b.jpg",
      "img/c.jpeg",
      "img/d.webp",
      "img/e.gif",
      "img/f.bmp",
      "img/g.txt",
      "img/h.svg",
      "img/i.avif",
      "img/noext",
    ];
    const questions = buildImageQuestions("img", files);
    expect(questions.map((q) => q.imagePath)).toEqual([
      "img/a.png",
      "img/b.jpg",
      "img/c.jpeg",
      "img/d.webp",
      "img/e.gif",
      "img/f.bmp",
    ]);
  });

  it("扩展名大小写不敏感", () => {
    const questions = buildImageQuestions("img", ["img/A.PNG", "img/B.Jpg"]);
    expect(questions).toHaveLength(2);
  });

  it("根目录图片分类为 识图/其它/其它", () => {
    const [q] = buildImageQuestions("img", ["img/root.png"]);
    expect(q.category1).toBe("识图");
    expect(q.category2).toBe("其它");
    expect(q.category3).toBe("其它");
    expect(q.id).toBe("img:root.png");
    expect(q.imagePath).toBe("img/root.png");
    expect(q.tags).toBe("#图片题");
    expect(q.optionA).toBe("");
    expect(q.optionD).toBe("");
    expect(q.favorite).toBe("");
    expect(q.wrong).toBe("");
  });

  it("A/B/C/img.png 分类为 识图/A/B（三级及更深忽略）", () => {
    const [q] = buildImageQuestions("img", ["img/A/B/C/img.png"]);
    expect(q.category1).toBe("识图");
    expect(q.category2).toBe("A");
    expect(q.category3).toBe("B");
  });

  it("A/img.png 分类为 识图/A/其它", () => {
    const [q] = buildImageQuestions("img", ["img/A/img.png"]);
    expect(q.category2).toBe("A");
    expect(q.category3).toBe("其它");
  });

  it("答案去扩展名并保留中间点", () => {
    const questions = buildImageQuestions("img", ["img/a.b.png"]);
    expect(questions[0].answer).toBe("a.b");
    expect(questions[0].stem).toBe("a.b");
  });

  it("按文件名排序并分配 imageNumber", () => {
    const files = ["img/b10.png", "img/a2.png", "img/a10.png", "img/a1.png"];
    const questions = buildImageQuestions("img", files);
    expect(questions.map((q) => q.answer)).toEqual(["a1", "a2", "a10", "b10"]);
    expect(questions.map((q) => q.imageNumber)).toEqual([1, 2, 3, 4]);
  });

  it("同名不同子目录仍可区分（id 含相对路径），并按相对路径稳定排序", () => {
    const files = ["img/B/same.png", "img/A/same.png"];
    const questions = buildImageQuestions("img", files);
    expect(questions.map((q) => q.id)).toEqual([
      "img:A/same.png",
      "img:B/same.png",
    ]);
    expect(questions.map((q) => q.imageNumber)).toEqual([1, 2]);
    expect(questions[0].answer).toBe("same");
    expect(questions[1].answer).toBe("same");
  });

  it("跳过隐藏文件与隐藏目录", () => {
    const files = [
      "img/ok.png",
      "img/.hidden.png",
      "img/.secret/inner.png",
      "img/sub/.hidden2.png",
    ];
    const questions = buildImageQuestions("img", files);
    expect(questions.map((q) => q.imagePath)).toEqual(["img/ok.png"]);
  });

  it("重复路径去重", () => {
    const files = ["img/a.png", "img/a.png", "img/a.png"];
    const questions = buildImageQuestions("img", files);
    expect(questions).toHaveLength(1);
    expect(questions[0].imageNumber).toBe(1);
  });

  it("不在文件夹下的路径被跳过", () => {
    const files = ["other/a.png", "imgs/b.png", "img/c.png"];
    const questions = buildImageQuestions("img", files);
    expect(questions.map((q) => q.imagePath)).toEqual(["img/c.png"]);
  });

  it("folder 规范化：trim、反斜杠、首尾斜杠与连续斜杠", () => {
    const files = ["notes/img/a.png"];
    for (const folder of [
      "notes/img",
      " notes/img ",
      "notes\\img",
      "/notes/img/",
      "notes//img",
    ]) {
      const questions = buildImageQuestions(folder, files);
      expect(questions).toHaveLength(1);
      expect(questions[0].imagePath).toBe("notes/img/a.png");
    }
  });

  it("空 folder 返回空数组", () => {
    expect(buildImageQuestions("", ["a.png"])).toEqual([]);
    expect(buildImageQuestions("   ", ["a.png"])).toEqual([]);
  });
});

describe("imageAnswerFromPath", () => {
  it("取 basename 并去掉最后一个扩展名", () => {
    expect(imageAnswerFromPath("A/B/a.b.png")).toBe("a.b");
    expect(imageAnswerFromPath("a b 中文.png")).toBe("a b 中文");
    expect(imageAnswerFromPath("a.PNG")).toBe("a");
    expect(imageAnswerFromPath("noext")).toBe("noext");
  });
});

describe("isImageQuestion", () => {
  it("imagePath 非空字符串才算图片题", () => {
    const base = buildImageQuestions("img", ["img/a.png"])[0];
    expect(isImageQuestion(base)).toBe(true);
    expect(isImageQuestion({ ...base, imagePath: "" })).toBe(false);
    expect(isImageQuestion({ ...base, imagePath: undefined })).toBe(false);
  });
});

describe("评分 key 与标签", () => {
  it("isImageRatingKey 只认四个 key", () => {
    expect(isImageRatingKey("again")).toBe(true);
    expect(isImageRatingKey("hard")).toBe(true);
    expect(isImageRatingKey("good")).toBe(true);
    expect(isImageRatingKey("easy")).toBe(true);
    expect(isImageRatingKey("AGAIN")).toBe(false);
    expect(isImageRatingKey("")).toBe(false);
    expect(isImageRatingKey("unknown")).toBe(false);
  });

  it("imageRatingLabel 返回中文标签，其它返回 null", () => {
    expect(imageRatingLabel("again")).toBe("重来");
    expect(imageRatingLabel("hard")).toBe("困难");
    expect(imageRatingLabel("good")).toBe("良好");
    expect(imageRatingLabel("easy")).toBe("简单");
    expect(imageRatingLabel("other")).toBeNull();
    expect(IMAGE_RATING_LABELS.easy).toBe("简单");
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { buildEpub, odtToHtml, splitChapters } from "./officeToEpub";

describe("office → EPUB", () => {
  it("converts ODT content and metadata", () => {
    const content = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>
      <text:h text:outline-level="1">Intro</text:h><text:p>Hello <text:span>world</text:span> &amp; more</text:p>
      <text:list><text:list-item><text:p>one</text:p></text:list-item></text:list>
      <text:h text:outline-level="2">Details</text:h><text:p>Second</text:p></office:text></office:body></office:document-content>`;
    const meta = `<?xml version="1.0"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>My Doc</dc:title><dc:creator>Ada</dc:creator></office:meta></office:document-meta>`;
    const odt = zipSync({ "content.xml": strToU8(content), "meta.xml": strToU8(meta) });
    const { html, meta: m } = odtToHtml(odt.buffer as ArrayBuffer);
    expect(html).toContain("<h1>Intro</h1>");
    expect(html).toContain("Hello world &amp; more");
    expect(html).toContain("<li><p>one</p></li>");
    expect(m).toMatchObject({ title: "My Doc", creator: "Ada" });
    const ch = splitChapters(html);
    expect(ch.map((c) => c.title)).toEqual(["Intro", "Details"]);
  });

  it("builds a valid EPUB container", () => {
    const epub = buildEpub("T", { creator: "Ada" }, [{ title: "A & B", html: "<p>x<br>y</p><img src='data:image/png;base64,AA'>" }]);
    const files = unzipSync(epub);
    expect(strFromU8(files.mimetype)).toBe("application/epub+zip");
    expect(Object.keys(files)[0]).toBe("mimetype");
    expect(strFromU8(files["OEBPS/content.opf"])).toContain("<dc:creator>Ada</dc:creator>");
    expect(strFromU8(files["OEBPS/nav.xhtml"])).toContain("A &amp; B");
    expect(strFromU8(files["OEBPS/c0.xhtml"])).toContain("<br/>");
    expect(new DOMParser().parseFromString(strFromU8(files["OEBPS/c0.xhtml"]), "application/xhtml+xml").getElementsByTagName("parsererror").length).toBe(0);
  });
});

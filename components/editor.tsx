"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Italic, List, ListOrdered, Quote, Undo2 } from "lucide-react";
import { useEffect } from "react";
export default function Editor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  let content = { type: "doc", content: [{ type: "paragraph" }] };
  try {
    content = JSON.parse(value || "null") || content;
  } catch {}
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "생각의 맥락, 근거, 반론을 기록하세요…",
      }),
    ],
    content,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "rich-editor",
        "aria-label": "노드 본문",
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor }) => onChange(JSON.stringify(editor.getJSON())),
  });
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== value) {
      try {
        editor.commands.setContent(
          JSON.parse(value || "null") || {
            type: "doc",
            content: [{ type: "paragraph" }],
          },
          { emitUpdate: false },
        );
      } catch {}
    }
  }, [value, editor]);
  if (!editor) return <div className="editor-loading">편집기 준비 중…</div>;
  const tools = [
    {
      name: "굵게",
      Icon: Bold,
      active: editor.isActive("bold"),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      name: "기울임",
      Icon: Italic,
      active: editor.isActive("italic"),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      name: "글머리 목록",
      Icon: List,
      active: editor.isActive("bulletList"),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      name: "번호 목록",
      Icon: ListOrdered,
      active: editor.isActive("orderedList"),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      name: "인용",
      Icon: Quote,
      active: editor.isActive("blockquote"),
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      name: "본문 실행 취소",
      Icon: Undo2,
      active: false,
      run: () => editor.chain().focus().undo().run(),
    },
  ];
  return (
    <div className="editor">
      <div className="editor-tools">
        {tools.map(({ name, Icon, active, run }) => (
          <button
            key={name}
            title={name}
            aria-label={name}
            aria-pressed={active}
            className={active ? "active" : ""}
            onClick={run}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

// Files bundled into the hub as text (Bun's \`with { type: "text" }\` imports).
declare module "*.sh" {
  const text: string;
  export default text;
}
declare module "*.md" {
  const text: string;
  export default text;
}
// No *.html here: Bun's own types claim that pattern (HTMLBundle), so editorSource.ts puts its type right.
declare module "*.py" {
  const text: string;
  export default text;
}

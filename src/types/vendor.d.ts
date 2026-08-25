declare module '@sabaki/sgf' {
  export interface SgfNode {
    id: string | number
    data: Record<string, string[]>
    parentId: string | number | null
    children: SgfNode[]
  }
  export function parse(contents: string): SgfNode[]
}

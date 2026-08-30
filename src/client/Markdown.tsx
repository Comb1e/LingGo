import {Fragment} from 'react'

export function Markdown({source}: {source: string}) {
  const lines = source.replace(/\r/g, '').split('\n')
  const nodes: React.ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (!list.length) return
    nodes.push(
      <ul key={`list-${nodes.length}`}>
        {list.map((value, index) => (
          <li key={index}>{value}</li>
        ))}
      </ul>,
    )
    list = []
  }
  lines.forEach((line, index) => {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    const item = /^[-*]\s+(.+)$/.exec(line)
    if (item) {
      list.push(item[1])
      return
    }
    flush()
    if (heading) {
      const Tag = `h${heading[1].length}` as 'h1' | 'h2' | 'h3' | 'h4'
      nodes.push(<Tag key={index}>{heading[2]}</Tag>)
    } else if (line.trim()) nodes.push(<p key={index}>{line}</p>)
  })
  flush()
  return (
    <div className="markdown">
      {nodes.length ? nodes : <Fragment>(none)</Fragment>}
    </div>
  )
}

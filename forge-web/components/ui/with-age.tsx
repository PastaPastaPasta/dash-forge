/**
 * `text · age` for a one-line event ("closed this · 4h ago"), with the age kept on the line of the
 * text's last word: on a phone it never wraps onto a line of its own (QW-070). No separator when
 * the age is unknown (`''`).
 */
export function WithAge({ text, age }: { text: string; age: string }): JSX.Element {
  if (age === '') return <>{text}</>
  const cut = text.lastIndexOf(' ')
  return (
    <>
      {cut === -1 ? '' : `${text.slice(0, cut)} `}
      <span className="whitespace-nowrap">
        {text.slice(cut + 1)} · {age}
      </span>
    </>
  )
}

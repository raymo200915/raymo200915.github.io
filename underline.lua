function Span(el)
  if el.classes:includes('underline') then
    return {
      pandoc.RawInline('html', '<u>'),
      table.unpack(el.content),
      pandoc.RawInline('html', '</u>')
    }
  end
end


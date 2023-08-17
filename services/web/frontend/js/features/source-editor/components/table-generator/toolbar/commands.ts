import { EditorView } from '@codemirror/view'
import { ColumnDefinition, Positions } from '../tabular'
import { ChangeSpec, EditorSelection } from '@codemirror/state'
import {
  CellSeparator,
  RowSeparator,
  parseColumnSpecifications,
} from '../utils'
import { TableSelection } from '../contexts/selection-context'
import { ensureEmptyLine } from '../../../extensions/toolbar/commands'
import { TableEnvironmentData } from '../contexts/table-context'
import {
  extendBackwardsOverEmptyLines,
  extendForwardsOverEmptyLines,
} from '../../../extensions/visual/selection'

/* eslint-disable no-unused-vars */
export enum BorderTheme {
  NO_BORDERS = 0,
  FULLY_BORDERED = 1,
}
/* eslint-enable no-unused-vars */
export const setBorders = (
  view: EditorView,
  theme: BorderTheme,
  positions: Positions,
  rowSeparators: RowSeparator[]
) => {
  const specification = view.state.sliceDoc(
    positions.columnDeclarations.from,
    positions.columnDeclarations.to
  )
  if (theme === BorderTheme.NO_BORDERS) {
    const removeColumnBorders = view.state.changes({
      from: positions.columnDeclarations.from,
      to: positions.columnDeclarations.to,
      insert: specification.replace(/\|/g, ''),
    })
    const removeHlines: ChangeSpec[] = []
    for (const row of positions.rowPositions) {
      for (const hline of row.hlines) {
        removeHlines.push({
          from: hline.from,
          to: hline.to,
          insert: '',
        })
      }
    }
    view.dispatch({
      changes: [removeColumnBorders, ...removeHlines],
    })
  } else if (theme === BorderTheme.FULLY_BORDERED) {
    let newSpec = '|'
    let consumingBrackets = 0
    for (const char of specification) {
      if (char === '{') {
        consumingBrackets++
      }
      if (char === '}' && consumingBrackets > 0) {
        consumingBrackets--
      }
      if (consumingBrackets) {
        newSpec += char
      }
      if (char === '|') {
        continue
      }
      newSpec += char + '|'
    }

    const insertColumns = view.state.changes({
      from: positions.columnDeclarations.from,
      to: positions.columnDeclarations.to,
      insert: newSpec,
    })

    const insertHlines: ChangeSpec[] = []
    for (const row of positions.rowPositions) {
      if (row.hlines.length === 0) {
        insertHlines.push(
          view.state.changes({
            from: row.from,
            to: row.from,
            insert: ' \\hline ',
          })
        )
      }
    }
    const lastRow = positions.rowPositions[positions.rowPositions.length - 1]
    if (lastRow.hlines.length < 2) {
      let toInsert = ' \\hline'
      if (rowSeparators.length < positions.rowPositions.length) {
        // We need a trailing \\
        toInsert = ` \\\\${toInsert}`
      }
      insertHlines.push(
        view.state.changes({
          from: lastRow.to,
          to: lastRow.to,
          insert: toInsert,
        })
      )
    }

    view.dispatch({
      changes: [insertColumns, ...insertHlines],
    })
  }
}

export const setAlignment = (
  view: EditorView,
  selection: TableSelection,
  alignment: 'left' | 'right' | 'center',
  positions: Positions
) => {
  const specification = view.state.sliceDoc(
    positions.columnDeclarations.from,
    positions.columnDeclarations.to
  )
  const columnSpecification = parseColumnSpecifications(specification)
  const { minX, maxX } = selection.normalized()
  for (let i = minX; i <= maxX; i++) {
    if (selection.isColumnSelected(i, positions.rowPositions.length)) {
      if (columnSpecification[i].alignment === alignment) {
        continue
      }
      columnSpecification[i].alignment = alignment
      // TODO: This won't work for paragraph, which needs width argument
      columnSpecification[i].content = alignment[0]
    }
  }
  const newSpecification = generateColumnSpecification(columnSpecification)
  view.dispatch({
    changes: [
      {
        from: positions.columnDeclarations.from,
        to: positions.columnDeclarations.to,
        insert: newSpecification,
      },
    ],
  })
}

const generateColumnSpecification = (columns: ColumnDefinition[]) => {
  return columns
    .map(
      ({ borderLeft, borderRight, content }) =>
        `${'|'.repeat(borderLeft)}${content}${'|'.repeat(borderRight)}`
    )
    .join('')
}

export const removeRowOrColumns = (
  view: EditorView,
  selection: TableSelection,
  positions: Positions,
  cellSeparators: CellSeparator[][]
) => {
  const {
    minX: startCell,
    maxX: endCell,
    minY: startRow,
    maxY: endRow,
  } = selection.normalized()
  const changes: { from: number; to: number; insert: string }[] = []
  const specification = view.state.sliceDoc(
    positions.columnDeclarations.from,
    positions.columnDeclarations.to
  )
  const columnSpecification = parseColumnSpecifications(specification)
  const numberOfColumns = columnSpecification.length
  const numberOfRows = positions.rowPositions.length

  if (selection.spansEntireTable(numberOfColumns, numberOfRows)) {
    emptyTable(view, columnSpecification, positions)
    return new TableSelection({ cell: 0, row: 0 })
  }
  const removedRows =
    Number(selection.isRowSelected(startRow, numberOfColumns)) *
    selection.height()
  const removedColumns =
    Number(selection.isColumnSelected(startCell, numberOfRows)) *
    selection.width()

  for (let row = startRow; row <= endRow; row++) {
    if (selection.isRowSelected(row, numberOfColumns)) {
      const rowPosition = positions.rowPositions[row]
      changes.push({
        from: rowPosition.from,
        to: rowPosition.to,
        insert: '',
      })
    } else {
      for (let cell = startCell; cell <= endCell; cell++) {
        if (selection.isColumnSelected(cell, numberOfRows)) {
          // FIXME: handle multicolumn
          if (cell === 0 && cellSeparators[row].length > 0) {
            // Remove the cell separator between the first and second cell
            changes.push({
              from: positions.cells[row][cell].from,
              to: cellSeparators[row][0].to,
              insert: '',
            })
          } else {
            // Remove the cell separator between the cell before and this if possible
            const cellPosition = positions.cells[row][cell]
            const from =
              cellSeparators[row][cell - 1]?.from ?? cellPosition.from
            const to = cellPosition.to
            changes.push({
              from,
              to,
              insert: '',
            })
          }
        }
      }
    }
  }
  const filteredColumns = columnSpecification.filter(
    (_, i) => !selection.isColumnSelected(i, numberOfRows)
  )
  const newSpecification = generateColumnSpecification(filteredColumns)
  changes.push({
    from: positions.columnDeclarations.from,
    to: positions.columnDeclarations.to,
    insert: newSpecification,
  })
  view.dispatch({ changes })
  const updatedNumberOfRows = numberOfRows - removedRows
  const updatedNumberOfColumns = numberOfColumns - removedColumns
  // Clamp selection to new table size
  return new TableSelection({
    cell: Math.max(0, Math.min(updatedNumberOfColumns - 1, startCell)),
    row: Math.max(0, Math.min(updatedNumberOfRows - 1, startRow)),
  })
}

const emptyTable = (
  view: EditorView,
  columnSpecification: ColumnDefinition[],
  positions: Positions
) => {
  const newColumns = columnSpecification.slice(0, 1)
  newColumns[0].borderLeft = 0
  newColumns[0].borderRight = 0
  const newSpecification = generateColumnSpecification(newColumns)
  const changes: ChangeSpec[] = []
  changes.push({
    from: positions.columnDeclarations.from,
    to: positions.columnDeclarations.to,
    insert: newSpecification,
  })
  const from = positions.rowPositions[0].from
  const to = positions.rowPositions[positions.rowPositions.length - 1].to
  changes.push({
    from,
    to,
    insert: '\\\\',
  })
  view.dispatch({ changes })
}

export const insertRow = (
  view: EditorView,
  selection: TableSelection,
  positions: Positions,
  below: boolean
) => {
  // TODO: Handle borders
  const { maxY, minY } = selection.normalized()
  const from = below
    ? positions.rowPositions[maxY].to
    : positions.rowPositions[minY].from
  const numberOfColumns = positions.cells[maxY].length
  const insert = `\n${' &'.repeat(numberOfColumns - 1)}\\\\`
  view.dispatch({ changes: { from, to: from, insert } })
  if (!below) {
    return selection
  }
  return new TableSelection(
    { cell: 0, row: maxY + 1 },
    { cell: numberOfColumns - 1, row: maxY + 1 }
  )
}

export const insertColumn = (
  view: EditorView,
  selection: TableSelection,
  positions: Positions,
  after: boolean
) => {
  // TODO: Handle borders
  // FIXME: Handle multicolumn
  const { maxX, minX } = selection.normalized()
  const changes: ChangeSpec[] = []
  for (const row of positions.cells) {
    const from = after ? row[maxX].to : row[minX].from
    changes.push({
      from,
      to: from,
      insert: ' &',
    })
  }

  const specification = view.state.sliceDoc(
    positions.columnDeclarations.from,
    positions.columnDeclarations.to
  )
  const columnSpecification = parseColumnSpecifications(specification)
  columnSpecification.splice(after ? maxX + 1 : minX, 0, {
    alignment: 'left',
    borderLeft: 0,
    borderRight: 0,
    content: 'l',
  })
  changes.push({
    from: positions.columnDeclarations.from,
    to: positions.columnDeclarations.to,
    insert: generateColumnSpecification(columnSpecification),
  })
  view.dispatch({ changes })
  if (!after) {
    return selection
  }
  return new TableSelection(
    { cell: maxX + 1, row: 0 },
    { cell: maxX + 1, row: positions.rowPositions.length - 1 }
  )
}

export const removeNodes = (
  view: EditorView,
  ...nodes: ({ from: number; to: number } | undefined)[]
) => {
  const changes: ChangeSpec[] = []
  for (const node of nodes) {
    if (node !== undefined) {
      changes.push({ from: node.from, to: node.to, insert: '' })
    }
  }
  view.dispatch({
    changes,
  })
}

const contains = (
  { from: outerFrom, to: outerTo }: { from: number; to: number },
  { from: innerFrom, to: innerTo }: { from: number; to: number }
) => {
  return outerFrom <= innerFrom && outerTo >= innerTo
}

export const moveCaption = (
  view: EditorView,
  positions: Positions,
  target: 'above' | 'below',
  tableEnvironment?: TableEnvironmentData
) => {
  const changes: ChangeSpec[] = []
  const position =
    target === 'above' ? positions.tabular.from : positions.tabular.to
  const cursor = EditorSelection.cursor(position)

  if (tableEnvironment?.caption) {
    const { caption: existingCaption } = tableEnvironment
    if (
      (existingCaption.from < positions.tabular.from && target === 'above') ||
      (existingCaption.from > positions.tabular.to && target === 'below')
    ) {
      // It's already in the right place
      return
    }
  }

  const { pos, prefix, suffix } = ensureEmptyLine(view.state, cursor, target)

  if (!tableEnvironment?.caption) {
    let labelText = '\\label{tab:my_table}'
    if (tableEnvironment?.label) {
      // We have a label, but no caption. Move the label after our caption
      changes.push({
        from: tableEnvironment.label.from,
        to: tableEnvironment.label.to,
        insert: '',
      })
      labelText = view.state.sliceDoc(
        tableEnvironment.label.from,
        tableEnvironment.label.to
      )
    }
    changes.push({
      ...gobbleEmptyLines(view, pos, 2, target),
      insert: `${prefix}\\caption{Caption}\n${labelText}${suffix}`,
    })
  } else {
    const { caption: existingCaption, label: existingLabel } = tableEnvironment
    // We have a caption, and we need to move it
    let currentCaption = view.state.sliceDoc(
      existingCaption.from,
      existingCaption.to
    )
    if (existingLabel && !contains(existingCaption, existingLabel)) {
      // Move label with it
      const labelText = view.state.sliceDoc(
        existingLabel.from,
        existingLabel.to
      )
      currentCaption += `\n${labelText}`
      changes.push({
        from: existingLabel.from,
        to: existingLabel.to,
        insert: '',
      })
    }
    changes.push({
      ...gobbleEmptyLines(view, pos, 2, target),
      insert: `${prefix}${currentCaption}${suffix}`,
    })
    // remove exsisting caption
    changes.push({
      from: existingCaption.from,
      to: existingCaption.to,
      insert: '',
    })
  }
  view.dispatch({ changes })
}

export const removeCaption = (
  view: EditorView,
  tableEnvironment?: TableEnvironmentData
) => {
  if (tableEnvironment?.caption && tableEnvironment.label) {
    if (contains(tableEnvironment.caption, tableEnvironment.label)) {
      return removeNodes(view, tableEnvironment.caption)
    }
  }
  return removeNodes(view, tableEnvironment?.caption, tableEnvironment?.label)
}

const gobbleEmptyLines = (
  view: EditorView,
  pos: number,
  lines: number,
  target: 'above' | 'below'
) => {
  const line = view.state.doc.lineAt(pos)
  if (line.length !== 0) {
    return { from: pos, to: pos }
  }
  if (target === 'above') {
    return {
      from: extendBackwardsOverEmptyLines(view.state.doc, line, lines),
      to: pos,
    }
  }
  return {
    from: pos,
    to: extendForwardsOverEmptyLines(view.state.doc, line, lines),
  }
}
import { CloseOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Checkbox, Flex, Input, Typography } from 'antd';
import { useState } from 'react';

const { Text } = Typography;

export type ItemView = {
  id: string;
  text: string;
  done: boolean;
};

export type ListData = {
  id: string;
  name: string;
  items: ItemView[];
};

function EditTextRow({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);

  function submit() {
    const trimmed = text.trim();
    if (trimmed && trimmed !== initial) onSave(trimmed);
    onCancel();
  }

  return (
    <Flex className="row" gap="small" align="center">
      <Input
        size="small"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPressEnter={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        autoFocus
      />
      <Button size="small" type="primary" onClick={submit}>
        OK
      </Button>
      <Button size="small" onClick={onCancel}>
        Cancel
      </Button>
    </Flex>
  );
}

function ItemRow({
  item,
  onToggle,
  onEdit,
  onArchive,
}: {
  item: ItemView;
  onToggle: () => void;
  onEdit: (text: string) => void;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <EditTextRow initial={item.text} onSave={onEdit} onCancel={() => setEditing(false)} />;
  }

  return (
    // the whole row toggles the item; its checkbox and buttons keep their clicks to themselves
    <Flex className="row item hoverable clickable" align="center" gap="small" onClick={onToggle}>
      <Checkbox checked={item.done} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
      <span className={item.done ? 'grow done' : 'grow'}>{item.text}</span>
      <Button
        className="hover-action"
        size="small"
        type="text"
        icon={<EditOutlined />}
        aria-label="edit item"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      />
      <Button
        className="hover-action"
        size="small"
        type="text"
        icon={<CloseOutlined />}
        aria-label="archive item"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      />
    </Flex>
  );
}

function InlineAdd({
  label,
  placeholder,
  className = 'add',
  onSubmit,
}: {
  label: string;
  placeholder: string;
  className?: string;
  onSubmit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditTextRow
        initial=""
        placeholder={placeholder}
        onSave={onSubmit}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={className}>
      <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setEditing(true)}>
        {label}
      </Button>
    </div>
  );
}

export default function ListView({
  list,
  onRenameList,
  onArchiveList,
  onAddItem,
  onToggleItem,
  onEditItem,
  onArchiveItem,
}: {
  list: ListData;
  onRenameList: (name: string) => void;
  onArchiveList: () => void;
  onAddItem: (text: string) => void;
  onToggleItem: (itemId: string, done: boolean) => void;
  onEditItem: (itemId: string, text: string) => void;
  onArchiveItem: (itemId: string) => void;
}) {
  const [renamingList, setRenamingList] = useState(false);

  return (
    <div className="list">
      <div className="list-title">
        {renamingList ? (
          <EditTextRow
            initial={list.name}
            onSave={onRenameList}
            onCancel={() => setRenamingList(false)}
          />
        ) : (
          <Flex className="row hoverable" align="center" gap="small">
            <Text strong className="grow">
              {list.name}
            </Text>
            <Button
              className="hover-action"
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label="rename list"
              onClick={() => setRenamingList(true)}
            />
            <Button
              className="hover-action"
              size="small"
              type="text"
              icon={<CloseOutlined />}
              aria-label="archive list"
              onClick={onArchiveList}
            />
          </Flex>
        )}
      </div>
      {list.items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          onToggle={() => onToggleItem(item.id, !item.done)}
          onEdit={(text) => onEditItem(item.id, text)}
          onArchive={() => onArchiveItem(item.id)}
        />
      ))}
      <InlineAdd label="item" placeholder="item text" onSubmit={onAddItem} />
    </div>
  );
}

export { InlineAdd };

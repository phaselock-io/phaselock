// The pieces both windows are built from.

import { EditOutlined } from '@ant-design/icons';
import { Avatar, Badge, Button, Flex, Input, Popover, Switch, Typography } from 'antd';
import { type ReactNode, useState } from 'react';

import { PALETTE, STATE_COLORS } from './theme';

const { Text } = Typography;

/** a patron's marker: the first letter of their name, in their color */
export function PatronAvatar({
  name,
  color,
  size = 22,
}: {
  name: string;
  color: string;
  size?: number;
}) {
  return (
    <Avatar
      size={size}
      style={{
        backgroundColor: color,
        color: PALETTE.onAccent,
        fontWeight: 600,
        fontSize: Math.round(size * 0.55),
        flexShrink: 0,
      }}>
      {name.slice(0, 1).toUpperCase()}
    </Avatar>
  );
}

/** a section's heading: small, muted capitals, with any action at its right */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <Flex align="center" className="section-head">
        <Text type="secondary" className="section-title">
          {title}
        </Text>
        <span className="grow" />
        {action}
      </Flex>
      {children}
    </section>
  );
}

/** the state of a window's connection, and the switch that takes it offline */
export function Connection({
  state,
  online,
  onOnline,
}: {
  state: keyof typeof STATE_COLORS;
  online: boolean;
  onOnline: (on: boolean) => void;
}) {
  return (
    <Flex align="center" gap={10}>
      <Badge color={STATE_COLORS[state]} text={<Text type="secondary">{state}</Text>} />
      <Switch size="small" checked={online} onChange={onOnline} title="online" />
    </Flex>
  );
}

/** a pencil that opens a small form to rename something */
export function Rename({
  value,
  label,
  onRename,
}: {
  value: string;
  label: string;
  onRename: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  // a name that changed and is not blank goes out; the form closes either way
  function save() {
    const name = draft.trim();
    if (name !== '' && name !== value) onRename(name);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(value);
        setOpen(next);
      }}
      trigger="click"
      title={label}
      content={
        <Flex gap="small">
          <Input
            size="small"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={save}
            autoFocus
          />
          <Button size="small" type="primary" onClick={save}>
            Save
          </Button>
        </Flex>
      }>
      <Button
        size="small"
        type="text"
        icon={<EditOutlined />}
        aria-label={label}
        className="rename"
      />
    </Popover>
  );
}

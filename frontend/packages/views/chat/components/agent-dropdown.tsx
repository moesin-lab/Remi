"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Agent } from "@multiremi/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import {
  PickerEmpty,
  PickerItem,
  PropertyPicker,
} from "../../issues/components/pickers/property-picker";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";

/**
 * Agent dropdown: avatar trigger, lists all available agents. Selecting a
 * different agent = switch agent + start a fresh chat (session=null).
 * The current agent is marked with a check and not clickable.
 */
export function AgentDropdown({
  agents,
  activeAgent,
  onSelect,
}: {
  agents: Agent[];
  activeAgent: Agent | null;
  onSelect: (agent: Agent) => void;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const query = filter.trim().toLowerCase();
  const matches = (name: string) =>
    !query || name.toLowerCase().includes(query) || matchesPinyin(name, query);
  const filteredAgents = agents.filter((agent) => matches(agent.name));

  const handlePick = (agent: Agent) => {
    onSelect(agent);
    setOpen(false);
  };

  if (!activeAgent) {
    return <span className="text-xs text-muted-foreground">{t(($) => $.window.no_agents)}</span>;
  }

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-64"
      align="start"
      side="top"
      searchable
      searchPlaceholder={t(($) => $.window.agent_filter_placeholder)}
      onSearchChange={setFilter}
      triggerRender={
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1 cursor-pointer outline-none transition-colors hover:bg-accent aria-expanded:bg-accent"
        />
      }
      trigger={
        <>
          <ActorAvatar
            actorType="agent"
            actorId={activeAgent.id}
            size={24}
            enableHoverCard
            showStatusDot
          />
          <span className="text-xs font-medium max-w-28 truncate">{activeAgent.name}</span>
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        </>
      }
    >
      {filteredAgents.length === 0 ? (
        <PickerEmpty />
      ) : (
        filteredAgents.map((agent) => (
          <AgentPickerItem
            key={agent.id}
            agent={agent}
            isCurrent={agent.id === activeAgent.id}
            onSelect={handlePick}
          />
        ))
      )}
    </PropertyPicker>
  );
}

function AgentPickerItem({
  agent,
  isCurrent,
  onSelect,
}: {
  agent: Agent;
  isCurrent: boolean;
  onSelect: (agent: Agent) => void;
}) {
  return (
    <PickerItem
      selected={isCurrent}
      onClick={() => onSelect(agent)}
    >
      <ActorAvatar
        actorType="agent"
        actorId={agent.id}
        size={24}
        enableHoverCard
        showStatusDot
      />
      <span className="truncate flex-1">{agent.name}</span>
    </PickerItem>
  );
}

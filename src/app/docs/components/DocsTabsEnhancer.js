"use client";

import { useEffect } from "react";
import PropTypes from "prop-types";

// Progressive enhancement for the tab groups in a docs article (markdown.js emits
// every panel visible, with a hidden tablist). Once this runs, the tablist is
// shown and only the selected panel stays visible.
//
// The chosen tab LABEL is remembered, not an index: someone who prefers "CC Switch"
// gets it on every page and in every group that has a tab with that label.
const STORAGE_KEY = "derouter.docs.tab";

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(label) {
  try {
    window.localStorage.setItem(STORAGE_KEY, label);
  } catch {
    /* private mode or blocked storage: the choice just is not remembered */
  }
}

function tabsOf(group) {
  return Array.from(group.querySelectorAll(':scope > [role="tablist"] > [role="tab"]'));
}

function select(group, tab, { focus = false } = {}) {
  for (const other of tabsOf(group)) {
    const active = other === tab;
    other.setAttribute("aria-selected", active ? "true" : "false");
    other.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(other.getAttribute("aria-controls"));
    if (panel) panel.hidden = !active;
  }
  if (focus) tab.focus();
}

export default function DocsTabsEnhancer({ rootSelector = ".docs-body", watch }) {
  useEffect(() => {
    const root = document.querySelector(rootSelector);
    if (!root) return undefined;
    const groups = Array.from(root.querySelectorAll(".docs-tabs"));
    const stored = readStored();

    for (const group of groups) {
      group.classList.add("docs-tabs-js");
      const tabs = tabsOf(group);
      const initial = tabs.find((tab) => tab.dataset.tabLabel === stored) ?? tabs[0];
      if (initial) select(group, initial);
    }

    // Choosing a label in one group switches every group with the same label.
    function choose(tab, { focus }) {
      const label = tab.dataset.tabLabel;
      writeStored(label);
      for (const group of groups) {
        const match = tabsOf(group).find((t) => t.dataset.tabLabel === label);
        if (match) select(group, match, { focus: focus && group === tab.closest(".docs-tabs") });
      }
    }

    function onClick(event) {
      const tab = event.target.closest?.('[role="tab"]');
      if (tab && root.contains(tab)) choose(tab, { focus: false });
    }

    function onKeyDown(event) {
      const tab = event.target.closest?.('[role="tab"]');
      if (!tab || !root.contains(tab)) return;
      const tabs = tabsOf(tab.closest(".docs-tabs"));
      const index = tabs.indexOf(tab);
      let next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      choose(next, { focus: true });
    }

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [rootSelector, watch]);

  return null;
}

DocsTabsEnhancer.propTypes = {
  rootSelector: PropTypes.string,
  watch: PropTypes.string,
};

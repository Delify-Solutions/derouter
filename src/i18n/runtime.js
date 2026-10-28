"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  
  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    console.error("Failed to load translations:", err);
    translationMap = {};
  }
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  
  // Catalog keys are single-spaced; JSX source and rendered text wrap lines
  const collapsed = trimmed.replace(/\s+/g, " ");
  return translationMap[trimmed] || translationMap[collapsed] || text;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Attributes whose values are visible to users
const TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];

// Elements whose content is code, not UI copy
const SKIP_TAGS = new Set(["script", "style", "code", "pre"]);

// Original + last rendered value per element/attribute. A WeakMap keeps the
// originals alive alongside their elements and never leaks detached nodes.
const attributeState = new WeakMap();

// Check whether an element, or any ancestor, is excluded from translation
function isTranslationSkipped(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;

  let current = element;
  while (current) {
    if (current.hasAttribute && current.hasAttribute("data-i18n-skip")) {
      return true;
    }
    if (SKIP_TAGS.has(current.tagName?.toLowerCase())) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

// Translate one attribute of an element, always from the stored original
function processAttribute(element, attribute) {
  if (!TRANSLATABLE_ATTRIBUTES.includes(attribute)) return;
  if (!element.hasAttribute(attribute)) return;
  if (isTranslationSkipped(element)) return;

  const current = element.getAttribute(attribute);

  let state = attributeState.get(element);
  if (!state) {
    state = {};
    attributeState.set(element, state);
  }

  let record = state[attribute];
  // A value that is neither the original nor what we last rendered was written
  // by the app (e.g. a React re-render), so it becomes the new original.
  if (!record || (current !== record.original && current !== record.translated)) {
    record = { original: current, translated: current };
    state[attribute] = record;
  }

  const translated = translate(record.original);
  record.translated = translated;

  if (translated !== current) {
    element.setAttribute(attribute, translated);
  }
}

// Process the translatable attributes of one element
function processElementAttributes(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

  TRANSLATABLE_ATTRIBUTES.forEach((attribute) => {
    processAttribute(element, attribute);
  });
}

// Translate a text node value, keeping the whitespace that separates it from
// sibling nodes. JSX splits sentences around inline elements, so dropping the
// padding here would glue fragments together.
function translateTextNodeValue(text) {
  const translated = translate(text);
  if (translated === text) return text;
  const leading = text.match(/^\s*/)[0];
  const trailing = text.match(/\s*$/)[0];
  return `${leading}${translated.trim()}${trailing}`;
}

// Elements whose text content is structured data, not readable copy
const STRUCTURAL_TAGS = new Set([
  "colgroup", "table", "thead", "tbody", "tfoot", "tr",
  "select", "datalist", "optgroup"
]);

// Process text node
function processTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return;
  
  const parent = node.parentElement;
  if (!parent) return;
  
  // Code and script containers are never UI copy, wherever they sit
  if (isTranslationSkipped(parent)) return;
  
  if (STRUCTURAL_TAGS.has(parent.tagName?.toLowerCase())) return;
  
  // Track the original value. A node whose current value is neither the
  // original nor our last translation was rewritten by the app (a React
  // re-render), so that value becomes the new original.
  const translatedNode = node._translatedText;
  if (node._originalText === undefined || (node.nodeValue !== node._originalText && node.nodeValue !== translatedNode)) {
    node._originalText = node.nodeValue;
    node._translatedText = node.nodeValue;
  }
  
  // Use original text for translation
  const original = node._originalText;
  const translated = translateTextNodeValue(original);
  node._translatedText = translated;
  
  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
  }
}

// Process all text nodes and translatable attributes in element
function processElement(element) {
  if (!element) return;
  
  if (element.nodeType === Node.ELEMENT_NODE) {
    processElementAttributes(element);
  }
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    null,
    false
  );
  
  let node;
  const nodesToProcess = [];
  
  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }
  
  // Process collected nodes
  nodesToProcess.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      processElementAttributes(node);
    } else {
      processTextNode(node);
    }
  });
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Process existing DOM
  processElement(document.body);
  
  // Watch for new nodes, in-place text updates and attribute updates
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        processAttribute(mutation.target, mutation.attributeName);
        return;
      }
      
      if (mutation.type === "characterData") {
        processTextNode(mutation.target);
        return;
      }
      
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRIBUTES,
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}

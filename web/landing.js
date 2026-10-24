import "./fonts.css";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { animate } from "animejs";
import Lenis from "lenis";
import {
  createIcons,
  Github,
  ArrowUpRight,
  ArrowDown,
  HardDrive,
  Braces,
  GitBranch,
  Plus,
  Folder,
  Send,
  FlaskConical,
  FolderGit2,
  Radio,
  ScanLine,
  FileCode2,
  Copy,
} from "lucide";
createIcons({
  icons: {
    Github,
    ArrowUpRight,
    ArrowDown,
    HardDrive,
    Braces,
    GitBranch,
    Plus,
    Folder,
    Send,
    FlaskConical,
    FolderGit2,
    Radio,
    ScanLine,
    FileCode2,
    Copy,
  },
});
// The static deployment is a product site, never a remote control for the local API.
const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if (!local)
  document.querySelectorAll(".local-studio-link").forEach((a) => {
    a.href = "#start";
    a.childNodes[0].textContent = "Install the local studio ";
  });
gsap.registerPlugin(ScrollTrigger);
const motion = gsap.matchMedia();
motion.add("(prefers-reduced-motion: no-preference)", () => {
  const lenis = new Lenis({
    autoRaf: true,
    anchors: true,
    duration: 0.85,
    prevent: (node) => !!node.closest("pre, .demo-code"),
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap
    .timeline({ defaults: { ease: "power3.out" } })
    .from(".hero-copy h1 span", {
      y: 28,
      opacity: 0,
      duration: 0.7,
      stagger: 0.09,
    })
    .from(
      ".hero-copy p,.hero-actions",
      { y: 12, opacity: 0, duration: 0.45, stagger: 0.08 },
      "-.35",
    )
    .from(
      ".signal-glyph",
      {
        rotation: -8,
        scale: 0.88,
        opacity: 0,
        svgOrigin: "280 280",
        duration: 1,
      },
      0,
    );
  gsap.to(".signal-glyph", {
    y: -22,
    rotation: 6,
    svgOrigin: "280 280",
    ease: "none",
    scrollTrigger: {
      trigger: ".hero",
      start: "top top",
      end: "bottom top",
      scrub: 1,
    },
  });
  gsap.from(".product-window", {
    y: 45,
    rotationX: 5,
    transformPerspective: 1200,
    duration: 0.8,
    ease: "power2.out",
    scrollTrigger: { trigger: ".product-window", start: "top 90%", once: true },
  });
  return () => lenis.destroy();
});
const samples = {
  profile: {
    title: "Get a profile",
    url: "https://api.example.com/v1/profile",
    body: {
      name: "Alex Morgan",
      role: "Developer",
      workspace: { name: "A good place to build", local: true },
      ready: true,
    },
  },
  projects: {
    title: "List projects",
    url: "https://api.example.com/v1/projects",
    body: {
      projects: [{ name: "My first API", status: "building" }],
      total: 1,
    },
  },
};
let current = "profile";
const code = document.getElementById("demo-code");
const safe = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function renderSample() {
  const sample = samples[current];
  document.getElementById("demo-title").textContent = sample.title;
  document.getElementById("demo-url").textContent = sample.url;
  code.innerHTML = safe(JSON.stringify(sample.body, null, 2)).replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|\d+)\b/g,
    (match, key, str, value) =>
      `<span class="${key ? "code-key" : str ? "code-string" : "code-bool"}">${match}</span>`,
  );
}
document.querySelectorAll("[data-demo]").forEach((button) =>
  button.addEventListener("click", () => {
    current = button.dataset.demo;
    document
      .querySelectorAll("[data-demo]")
      .forEach((b) => b.classList.toggle("selected", b === button));
    renderSample();
    document.getElementById("demo-status").textContent = "Sample response";
  }),
);
document.getElementById("demo-send").addEventListener("click", () => {
  renderSample();
  const status = document.getElementById("demo-status");
  status.textContent = "200 OK · sample data";
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    animate(code, { opacity: [0.35, 1], duration: 300, ease: "outQuad" });
});
let copyTimer;
document.getElementById("copy-install").addEventListener("click", async () => {
  const status = document.getElementById("copy-status");
  try {
    await navigator.clipboard.writeText(
      document.getElementById("install-code").textContent,
    );
    status.textContent = "Installation commands copied.";
  } catch {
    status.textContent =
      "Select and copy the commands from the terminal block.";
  }
  clearTimeout(copyTimer);
  status.style.display = "block";
  copyTimer = setTimeout(() => (status.style.display = "none"), 3000);
});

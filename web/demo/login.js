"use strict";
const form = document.querySelector("#demo-login");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const error = document.querySelector("#login-error");
const suggested = new URL(location.href).searchParams.get("account");
if (["demo-member", "demo-chair"].includes(suggested)) username.value = suggested;
function enterDemo(persona) {
  sessionStorage.setItem("ato-scholarship-demo-login", persona);
  location.assign(`/demo/#${persona === "chair" ? "queue" : "overview"}`);
}
for (const button of document.querySelectorAll("[data-account]")) {
  button.addEventListener("click", () => {
    enterDemo(button.dataset.account === "demo-chair" ? "chair" : "alex");
  });
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const persona = { "demo-member": "alex", "demo-chair": "chair" }[username.value.trim().toLowerCase()];
  if (!persona || password.value !== "Demo2026!") {
    error.textContent = "Use one of the demo usernames and the password shown below.";
    error.hidden = false;
    return;
  }
  enterDemo(persona);
});

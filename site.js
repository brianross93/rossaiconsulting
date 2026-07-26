(function () {
  var header = document.querySelector("[data-site-header]");
  var toggle = document.querySelector("[data-nav-toggle]");
  var navigation = document.getElementById("site-navigation");

  function setMenu(open) {
    if (!header || !toggle) {
      return;
    }

    header.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    document.documentElement.classList.toggle("menu-open", open);
  }

  if (header && toggle && navigation) {
    toggle.addEventListener("click", function () {
      setMenu(toggle.getAttribute("aria-expanded") !== "true");
    });

    navigation.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        setMenu(false);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setMenu(false);
        toggle.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (
        toggle.getAttribute("aria-expanded") === "true" &&
        !header.contains(event.target)
      ) {
        setMenu(false);
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 980) {
        setMenu(false);
      }
    });
  }

  function updateHeader() {
    if (header) {
      header.classList.toggle("is-scrolled", window.scrollY > 12);
    }
  }

  window.addEventListener("scroll", updateHeader, { passive: true });
  updateHeader();

  var currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
  document.querySelectorAll("#site-navigation a[href]").forEach(function (link) {
    var linkPath = new URL(link.href, window.location.origin).pathname;
    linkPath = linkPath.replace(/\/+$/, "") || "/";

    if (
      linkPath === currentPath ||
      (linkPath !== "/" && currentPath.indexOf(linkPath + "/") === 0)
    ) {
      link.setAttribute("aria-current", "page");
    }
  });

  document.querySelectorAll("[data-current-year]").forEach(function (element) {
    element.textContent = String(new Date().getFullYear());
  });
})();

class ProductSignUp extends HTMLElement {
  constructor() {
    super();

    this.openBtn = this.querySelector(".p-signup__button[data-open-signup]");
    this.submitBtn = this.querySelector(".p-signup__button[data-submit]");
    this.signUpForm = this.querySelector(".p-signup__form");

    this.init();
  }

  init() {
    this.attachSignUpListeners();
  }

  attachSignUpListeners() {
    this.openBtn.addEventListener("click", () => {
      this.onOpenClick();
    });
    this.signUpForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.onSubmit(e);
    });
  }

  onOpenClick(e) {
    this.classList.add("active");
  }

  onSubmit(e) {
    e.preventDefault();
    this.submitBtn.classList.add("loading");
  }

  onSuccess(e) {
    this.classList.remove("active");
    this.classList.add("success");
  }
}

customElements.define("product-signup", ProductSignUp);

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
    const formData = new FormData(this.signUpForm);
    const formDataObject = Object.fromEntries(formData);
    const firstName = formDataObject.first_name || "";
    const lastName = formDataObject.last_name || "";
    const email = formDataObject.email;
    const checkbox = formDataObject.checkbox == "on" ? true : false;
    console.log(firstName, lastName, email, checkbox);
    fetch(
      "https://faas-fra1-afec6ce7.doserverless.co/api/v1/web/fn-2321b64e-f816-4415-acfa-9ebbd8824f76/node-fetch/create-customer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          firstName: firstName,
          lastName: lastName,
          marketing: checkbox,
        }),
      }
    )
      .then((response) => {
        if (!response.ok)
          throw new Error(`HTTP error! Status: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        console.log(data);
        if (data.message == "You are already a Loyalty program Member") {
          this.onError(data);
          return;
        }
        this.onSuccess(data);
      })
      .catch((err) => {
        console.error("❌ Fetch error:", err);
      });
  }

  onSuccess(data) {
    this.classList.remove("active");
    this.classList.add("success");
  }

  onError(data) {
    this.querySelector(".p-signup__error-heading").innerText = data.message;
    this.classList.remove("active");
    this.classList.add("error");
  }
}

customElements.define("product-signup", ProductSignUp);

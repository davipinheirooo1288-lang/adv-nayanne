const phoneNumber = "5577998050796";
const defaultMessage =
  "Olá, Nayanne Lis. Vim pelo site e gostaria de atendimento jurídico.";

const faqAnswers = {
  regularizacao: {
    title: "Como funciona a regularização de imóveis?",
    answer:
      "A regularização reúne, confere e corrige a documentação do imóvel para que ele esteja em conformidade com a lei. A análise identifica pendências, define a estratégia e conduz o processo junto aos órgãos competentes até a solução adequada para o caso."
  },
  inventario: {
    title: "Inventário pode ser feito em cartório ou precisa ser judicial?",
    answer:
      "Depende do caso. O inventário extrajudicial, feito em cartório, costuma ser mais rápido quando todos os herdeiros são maiores, capazes e estão de acordo. Quando há menores, divergências ou testamento, o caminho pode ser judicial."
  },
  online: {
    title: "Vocês atendem de forma online ou presencial?",
    answer:
      "Sim. O atendimento pode ser realizado online para clientes em todo o Brasil e presencialmente em Porto Seguro-BA, conforme a necessidade do caso."
  },
  documentos: {
    title: "Quais documentos são necessários para iniciar?",
    answer:
      "Depende da demanda. Para iniciar, envie uma breve explicação do caso e os documentos que já possui, como matrícula, escritura, contrato, certidões, comprovantes de posse ou documentos de inventário."
  },
  prazo: {
    title: "Qual o prazo para análise do meu caso?",
    answer:
      "O prazo varia conforme a complexidade e a documentação disponível. A primeira orientação pelo WhatsApp ajuda a entender o caso e indicar os próximos passos com mais precisão."
  }
};

const buildWhatsAppLink = (message = defaultMessage) =>
  `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;

document.querySelectorAll("[data-whatsapp]").forEach((link) => {
  link.href = buildWhatsAppLink(link.dataset.whatsapp);
});

const revealObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.16 }
    )
  : null;

document.querySelectorAll(".reveal").forEach((section, index) => {
  section.style.transitionDelay = `${Math.min(index * 35, 220)}ms`;
  if (revealObserver) {
    revealObserver.observe(section);
  } else {
    section.classList.add("is-visible");
  }
});

const dialog = document.querySelector("#faq-dialog");
const dialogTitle = document.querySelector("#faq-dialog-title");
const dialogAnswer = document.querySelector("#faq-dialog-answer");
const dialogClose = document.querySelector(".faq-dialog__close");

document.querySelectorAll("[data-faq]").forEach((button) => {
  button.addEventListener("click", () => {
    const faq = faqAnswers[button.dataset.faq];
    if (!faq || !dialog) return;

    dialogTitle.textContent = faq.title;
    dialogAnswer.textContent = faq.answer;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      alert(`${faq.title}\n\n${faq.answer}`);
    }
  });
});

dialogClose?.addEventListener("click", () => dialog?.close());
dialog?.addEventListener("click", (event) => {
  const rect = dialog.getBoundingClientRect();
  const isInDialog =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;

  if (!isInDialog) {
    dialog.close();
  }
});

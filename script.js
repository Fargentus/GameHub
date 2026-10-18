document.addEventListener('DOMContentLoaded', () => {
    const langBtn = document.querySelector('.lang-btn');
    const langMenu = document.querySelector('.lang-menu');
    const langDropdown = document.querySelector('.language-dropdown');

    if (langBtn && langMenu) {
        langBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            langMenu.classList.toggle('show');
        });

        document.addEventListener('click', (e) => {
            if (!langDropdown.contains(e.target)) {
                langMenu.classList.remove('show');
            }
        });

        const langItems = langMenu.querySelectorAll('li');
        Array.from(langItems).forEach(item => {
            item.addEventListener('click', () => {
                langBtn.textContent = item.textContent;
                langMenu.classList.remove('show');
            });
        });
    }

    const searchInput = document.querySelector('.search-conteiner input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            console.log('Пошуковий запит:', query);
        });
    }

    const filterBtn = document.querySelector('.filter-btn');
    if (filterBtn) {
        filterBtn.addEventListener('click', () => {
            console.log('Кнопку фільтрів натиснуто');
        });
    }
});

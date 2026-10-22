"use strict";

const CONFIG = {
    apiBase: "http://gamehubproxy.kitpvp.su:40063",
    steamStore: "https://store.steampowered.com",
    country: "ua",
    language: "ukrainian",
    pageSize: 50,
    requestTimeout: 20000,
    detailsConcurrency: 4,
    scrollThreshold: 700
};

const ELEMENTS = {
    searchInput: document.getElementById("searchInput"),
    searchBtn: document.getElementById("searchBtn"),
    genresBtn: document.getElementById("genresBtn"),
    categoryBtn: document.getElementById("categoryBtn"),
    resultsInfo: document.getElementById("resultsInfo"),
    gamesGrid: document.getElementById("gamesGrid"),
    modal: document.getElementById("modal"),
    modalBody: document.getElementById("modalBody"),
    modalClose: document.getElementById("modalClose")
};

const GENRES = {
    action: { label: "Екшн", ids: [19, 1773, 21] },
    adventure: { label: "Пригоди", ids: [21, 1684] },
    rpg: { label: "Рольові ігри", ids: [122, 1664, 4231] },
    strategy: { label: "Стратегії", ids: [9, 19] },
    simulation: { label: "Симулятори", ids: [599, 128, 4172] },
    sports: { label: "Спорт", ids: [701, 3878] },
    racing: { label: "Перегони", ids: [699, 1734] },
    horror: { label: "Жахи", ids: [1667, 1697] },
    survival: { label: "Виживання", ids: [1662, 1667] },
    fps: { label: "Шутери від першої особи", ids: [1663, 1774] },
    multiplayer: { label: "Мультиплеєр", ids: [3859, 128, 3843] },
    openworld: { label: "Відкритий світ", ids: [1695] },
    indie: { label: "Інді", ids: [492] },
    casual: { label: "Казуальні", ids: [597] },
    free: { label: "Безкоштовні", ids: [] }
};

const state = {
    query: "",
    selectedGenre: "",
    selectedCategory: "",
    offset: 0,
    loading: false,
    exhausted: false,
    sourceExhausted: false,
    requestId: 0,
    games: [],
    pendingMatches: [],
    knownAppIds: new Set(),
    detailCache: new Map(),
    detailQueue: [],
    activeDetails: 0,
    detailPromises: new Map(),
    queuedDetailIds: new Set(),
    searchController: null,
    modalRequestId: 0,
    scrollFrame: 0
};

function normalizeText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^a-zа-я0-9]+/gi, " ")
        .trim();
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[char]);
}


function isRelevantTitle(title, query) {
    const normalizedTitle = normalizeText(title);
    const normalizedQuery = normalizeText(query);

    if (!normalizedQuery) return true;

    const aliases = {
        cs2: ["counter strike 2"],
        csgo: ["counter strike global offensive"],
        gta5: ["grand theft auto v", "gta v"],
        rdr2: ["red dead redemption 2"]
    };

    const alternatives = aliases[normalizedQuery];

    if (alternatives) {
        return alternatives.some(alias => {
            const normalizedAlias = normalizeText(alias);

            return normalizedTitle === normalizedAlias
                || normalizedTitle.includes(normalizedAlias);
        });
    }

    const words = normalizedQuery.split(/\s+/).filter(Boolean);

    return words.every(word =>
        normalizedTitle.split(/\s+/).some(titleWord =>
            titleWord.includes(word)
        )
    );
}

function buildSteamURL(path, params = {}) {
    const url = new URL(CONFIG.steamStore + path);

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    return url.toString();
}

async function fetchText(url, options = {}) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    let timedOut = false;

    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, CONFIG.requestTimeout);

    const abortFromExternal = () => controller.abort();

    if (externalSignal?.aborted) {
        clearTimeout(timeout);
        throw new DOMException("Запрос отменён", "AbortError");
    }

    externalSignal?.addEventListener("abort", abortFromExternal, {
        once: true
    });

    try {
        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal,
            credentials: "omit"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();

        if (!text.trim()) {
            throw new Error("API вернул пустой ответ");
        }

        return text;
    } catch (error) {
        if (error.name === "AbortError" && timedOut) {
            throw new Error("Превышено время ожидания ответа API");
        }

        throw error;
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abortFromExternal);
    }
}

async function fetchJSON(url, options = {}) {
    return JSON.parse(await fetchText(url, options));
}

function buildSearchURL(offset) {
    const url = new URL(`${CONFIG.apiBase}/steam/search`);

    url.searchParams.set("term", state.query);
    url.searchParams.set("start", String(offset));
    url.searchParams.set("count", String(CONFIG.pageSize));
    url.searchParams.set("cc", CONFIG.country);
    url.searchParams.set("l", CONFIG.language);

    return url.toString();
}

function extractTagIds(row) {
    const raw = row.getAttribute("data-ds-tagids");

    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
            return parsed.map(Number).filter(Number.isFinite);
        }
    } catch {}

    return (raw.match(/\d+/g) || []).map(Number);
}

function parseRating(row) {
    const node = row.querySelector(".search_review_summary");

    const text = node?.getAttribute("data-tooltip-html")
        || node?.getAttribute("data-tooltip-text")
        || node?.textContent
        || "";

    const match = text.match(/(\d+)%/);

    return {
        percent: match ? Number(match[1]) : null,
        text: text
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    };
}

function parsePrice(row) {
    const node = row.querySelector(".discount_final_price")
        || row.querySelector(".search_price");

    return node?.textContent.replace(/\s+/g, " ").trim()
        || "Ціну не вказано";
}

function parseSteamSearch(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    const rows = doc.querySelectorAll(
        "a.search_result_row[data-ds-appid], " +
        "a[data-ds-appid], " +
        "[data-ds-appid].search_result_row"
    );

    const games = [];
    const seenIds = new Set();

    for (const row of rows) {
        const rawAppId = row.getAttribute("data-ds-appid");
        const appId = Number(rawAppId?.split(",")[0]);

        if (!Number.isSafeInteger(appId) || appId <= 0) {
            continue;
        }

        if (seenIds.has(appId)) {
            continue;
        }

        const titleNode = row.querySelector(
            ".title, .search_name"
        );

        const title = titleNode?.textContent
            ?.replace(/\s+/g, " ")
            .trim();

        if (!title) {
            continue;
        }

        const image = row.querySelector("img");
        const rating = parseRating(row);

        seenIds.add(appId);

        games.push({
            appId,
            title,
            image: image?.getAttribute("src")
                || image?.getAttribute("data-src")
                || image?.getAttribute("srcset")?.split(",")[0]?.trim().split(" ")[0]
                || "",
            price: parsePrice(row),
            ratingPercent: rating.percent,
            ratingText: rating.text,
            tagIds: extractTagIds(row),
            steamURL: `${CONFIG.steamStore}/app/${appId}/`
        });
    }

    return games;
}

function isFreeGame(game) {
    return /free|безкоштов/i.test(game.price)
        || game.price.includes("0,00")
        || game.price.includes("$0.00");
}

function matchesGenre(game) {
    if (!state.selectedGenre) return true;

    if (state.selectedGenre === "free") {
        return isFreeGame(game);
    }

    const genre = GENRES[state.selectedGenre];

    if (!genre) return true;

    if (!game.tagIds.length) return false;

    return genre.ids.some(id => game.tagIds.includes(id));
}

function matchesCategory(game) {
    switch (state.selectedCategory) {
        case "popular":
            return (game.ratingPercent ?? 0) >= 80;

        case "positive":
            return (game.ratingPercent ?? 0) >= 70;

        case "free":
            return isFreeGame(game);

        default:
            return true;
    }
}

function shouldDisplayGame(game) {
    return isRelevantTitle(game.title, state.query)
        && matchesGenre(game)
        && matchesCategory(game);
}

function starsForRating(percent) {
    if (percent == null) {
        return '<span class="rating-stars">☆☆☆☆☆</span>';
    }

    const filled = Math.max(0, Math.min(5, Math.round(percent / 20)));

    return `<span class="rating-stars" aria-label="${filled} з 5 зірок">${"★".repeat(filled)}${"☆".repeat(5 - filled)}</span>`;
}

function createGameCard(game) {
    const card = document.createElement("article");

    card.className = "game-card";
    card.dataset.appid = String(game.appId);

    const rating = game.ratingPercent == null
        ? starsForRating(null)
        : `${starsForRating(game.ratingPercent)} <span class="rating-percent">${game.ratingPercent}%</span>`;

    card.innerHTML = `
        <button class="game-card-button" type="button">
            <div class="game-image-wrap">
                <img class="game-image game-poster"
                    src="${escapeHTML(game.image)}"
                    alt="${escapeHTML(game.title)}"
                    loading="lazy"
                    decoding="async">
            </div>

            <div class="game-card-content game-info">
                <h3 class="game-title">${escapeHTML(game.title)}</h3>
                <p class="game-short-description">Завантаження опису…</p>
                <div class="game-rating">${rating}</div>
                <div class="game-price">${escapeHTML(game.price)}</div>
                <div class="game-genres"></div>
            </div>
        </button>
    `;

    card.querySelector(".game-card-button").addEventListener("click", () => {
        openGameModal(game.appId);
    });

    const image = card.querySelector("img");

    image.addEventListener("error", () => {
        image.style.visibility = "hidden";
    }, { once: true });

    queueGameDetails(game.appId);

    return card;
}

function renderGames(games, append = false) {
    if (!ELEMENTS.gamesGrid) return;

    if (!append) {
        ELEMENTS.gamesGrid.replaceChildren();
    }

    const fragment = document.createDocumentFragment();

    for (const game of games) {
        fragment.appendChild(createGameCard(game));
    }

    ELEMENTS.gamesGrid.appendChild(fragment);

    updateResultsInfo();
}

function updateResultsInfo() {
    if (!ELEMENTS.resultsInfo) return;

    const count = ELEMENTS.gamesGrid
        ?.querySelectorAll(".game-card").length || 0;

    if (state.loading) {
        ELEMENTS.resultsInfo.textContent =
            `Завантаження… Показано ігор: ${count}`;
    } else if (!count && state.exhausted) {
        ELEMENTS.resultsInfo.textContent =
            "Ігор не знайдено. Спробуйте змінити запит або фільтри.";
    } else if (state.exhausted) {
        ELEMENTS.resultsInfo.textContent = `Знайдено ігор: ${count}`;
    } else {
        ELEMENTS.resultsInfo.textContent = `Показано ігор: ${count}`;
    }
}

function takePendingMatches(target) {
    while (
        target.length < CONFIG.pageSize &&
        state.pendingMatches.length
    ) {
        target.push(state.pendingMatches.shift());
    }
}



async function loadNextPage() {
    if (state.loading || state.exhausted) return;

    state.loading = true;
    const requestId = state.requestId;
    let addedCount = 0;

    updateResultsInfo();

   
    function appendGame(game) {
        if (requestId !== state.requestId) return false;

        ELEMENTS.gamesGrid.appendChild(createGameCard(game));
        addedCount++;
        updateResultsInfo();

        return true;
    }

    try {
       
        while (
            state.pendingMatches.length > 0 &&
            addedCount < CONFIG.pageSize
        ) {
            appendGame(state.pendingMatches.shift());

            await new Promise(resolve =>
                requestAnimationFrame(resolve)
            );
        }

       
        while (
            addedCount < CONFIG.pageSize &&
            !state.sourceExhausted
        ) {
            const url = buildSearchURL(state.offset);
            let parsedGames = null;
            let lastError = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const html = await fetchText(url, {
                        signal: state.searchController?.signal
                    });

                    if (requestId !== state.requestId) return;

                    parsedGames = parseSteamSearch(html);
                    break;
                } catch (error) {
                   
                    if (
                        requestId !== state.requestId ||
                        error.name === "AbortError"
                    ) {
                        return;
                    }
                
                    lastError = error;
                
                    if (attempt < 3) {
                        await new Promise(resolve =>
                            setTimeout(resolve, attempt * 500)
                        );
                    }
                }
            }

            if (requestId !== state.requestId) return;

            if (parsedGames === null) {
                throw lastError || new Error("Не удалось загрузить страницу");
            }

            if (parsedGames.length === 0) {
                state.sourceExhausted = true;
                break;
            }

            state.offset += parsedGames.length;

            for (const game of parsedGames) {
                if (requestId !== state.requestId) return;
                if (state.knownAppIds.has(game.appId)) continue;

                state.knownAppIds.add(game.appId);
                state.games.push(game);

                if (shouldDisplayGame(game)) {
                    if (addedCount < CONFIG.pageSize) {
                        appendGame(game);

                        await new Promise(resolve =>
                            requestAnimationFrame(resolve)
                        );
                    } else {
                        state.pendingMatches.push(game);
                    }
                }
            }
        }

        if (requestId !== state.requestId) return;

        state.exhausted =
            state.sourceExhausted &&
            state.pendingMatches.length === 0;

    } catch (error) {
        if (
            requestId === state.requestId &&
            error.name !== "AbortError"
        ) {
            console.error("Ошибка загрузки Steam:", error);
            setStatus(`Не удалось загрузить игры: ${error.message}`);
        }
    } finally {
        if (requestId === state.requestId) {
            state.loading = false;
            updateResultsInfo();
        }
    }
}



function setStatus(message) {
    if (ELEMENTS.resultsInfo) {
        ELEMENTS.resultsInfo.textContent = message;
    }
}


function resetSearch() {
   
    state.searchController?.abort();
    state.searchController = new AbortController();

    state.requestId++;

    state.query = ELEMENTS.searchInput?.value.trim() || "";

   
    if (state.query) {
        state.selectedGenre = "";
    }

    state.offset = 0;
    state.loading = false;
    state.exhausted = false;
    state.sourceExhausted = false;
    state.games = [];
    state.pendingMatches = [];
    state.knownAppIds.clear();

    ELEMENTS.gamesGrid?.replaceChildren();

    setStatus("Пошук ігор…");
    loadNextPage();
}



function onScroll() {
    if (state.scrollFrame) return;

    state.scrollFrame = requestAnimationFrame(() => {
        state.scrollFrame = 0;

        if (state.loading || state.exhausted) return;

        const cards = ELEMENTS.gamesGrid?.querySelectorAll(".game-card");

        if (!cards?.length) return;

        const triggerIndex = Math.max(
            0,
            cards.length - Math.ceil(CONFIG.pageSize / 2)
        );

        const triggerCard = cards[triggerIndex];

        if (!triggerCard) return;

        const rect = triggerCard.getBoundingClientRect();

        if (rect.top < window.innerHeight + CONFIG.scrollThreshold) {
            loadNextPage();
        }
    });
}


async function fetchGameDetails(appId) {
    const url = new URL(`${CONFIG.apiBase}/steam/appdetails`);

    url.searchParams.set("appids", String(appId));
    url.searchParams.set("cc", CONFIG.country);
    url.searchParams.set("l", CONFIG.language);

    const json = await fetchJSON(url.toString());
    const entry = json[String(appId)];

    if (!entry?.success || !entry.data) {
        throw new Error("Не вдалося отримати інформацію про гру");
    }

    const data = entry.data;

    const cleanDescription = value => {
        const container = document.createElement("div");
        container.innerHTML = value || "";

        return (container.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
    };

    return {
        appId,
        name: data.name || "Без назви",
        headerImage: data.header_image || "",
        shortDescription: cleanDescription(data.short_description),
        description: cleanDescription(data.detailed_description),
        developers: data.developers || [],
        publishers: data.publishers || [],
        genres: (data.genres || []).map(item => item.description),

        screenshots: (data.screenshots || []).map(item => ({
            thumbnail: item.path_thumbnail || item.path_full || "",
            full: item.path_full || item.path_thumbnail || ""
        })).filter(item => item.full),

        movies: (data.movies || []).map(item => ({
            name: item.name || "Трейлер",
            thumbnail: item.thumbnail || "",
            mp4: item.mp4?.max || item.mp4?.["480"] || "",
            webm: item.webm?.max || item.webm?.["480"] || ""
        })).filter(item => item.mp4 || item.webm),

        releaseDate: data.release_date?.date || "Не вказано",

        price: data.price_overview?.final_formatted
            || (data.is_free ? "Безкоштовно" : "Ціну не вказано"),

        steamURL: `${CONFIG.steamStore}/app/${appId}/`
    };
}

function queueGameDetails(appId) {
    if (
        state.detailCache.has(appId) ||
        state.detailPromises.has(appId) ||
        state.queuedDetailIds.has(appId)
    ) {
        return;
    }

    state.queuedDetailIds.add(appId);
    state.detailQueue.push(appId);

    processDetailQueue();
}

function processDetailQueue() {
    while (
        state.activeDetails < CONFIG.detailsConcurrency &&
        state.detailQueue.length
    ) {
        const appId = state.detailQueue.shift();
        state.queuedDetailIds.delete(appId);

        if (
            state.detailCache.has(appId) ||
            state.detailPromises.has(appId)
        ) {
            continue;
        }

        state.activeDetails++;

        const promise = fetchGameDetails(appId)
            .then(details => {
                state.detailCache.set(appId, details);
                updateCardDetails(appId, details);
                return details;
            })
            .catch(error => {
                console.warn(
                    `Не вдалося завантажити гру ${appId}:`,
                    error
                );

                state.detailCache.set(appId, null);
                return null;
            })
            .finally(() => {
                state.detailPromises.delete(appId);
                state.activeDetails--;
                processDetailQueue();
            });

        state.detailPromises.set(appId, promise);
    }
}

function updateCardDetails(appId, details) {
    if (!details) return;

    const card = ELEMENTS.gamesGrid?.querySelector(
        `.game-card[data-appid="${appId}"]`
    );

    if (!card) return;

    const genreContainer = card.querySelector(".game-genres");

    if (genreContainer && details.genres.length) {
        genreContainer.innerHTML = details.genres
            .slice(0, 3)
            .map(genre =>
                `<span class="game-genre">${escapeHTML(genre)}</span>`
            )
            .join("");
    }

    const description = card.querySelector(".game-short-description");

    if (description) {
        description.textContent =
            details.shortDescription || "Короткий опис недоступний.";
    }

    const image = card.querySelector(".game-image");

    if (image && details.headerImage) {
        image.src = details.headerImage;
        image.style.visibility = "visible";
    }
}

function openModal() {
    if (!ELEMENTS.modal) return;

    ELEMENTS.modal.classList.add("active", "is-open");
    document.body.classList.add("modal-open");
    ELEMENTS.modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
    state.modalRequestId++;

    if (!ELEMENTS.modal) return;

    ELEMENTS.modal.classList.remove("active", "is-open");
    document.body.classList.remove("modal-open");
    ELEMENTS.modal.setAttribute("aria-hidden", "true");
}

function renderModalLoading(title) {
    if (!ELEMENTS.modalBody) return;

    ELEMENTS.modalBody.innerHTML = `
        <div class="game-modal-layout">
            <div class="game-modal-info">
                <h2 class="game-modal-title">${escapeHTML(title)}</h2>
                <p>Завантаження інформації про гру…</p>
            </div>
        </div>
    `;
}

function renderModalDetails(details, fallback) {
    if (!ELEMENTS.modalBody) return;

    if (!details) {
        ELEMENTS.modalBody.innerHTML = `
            <div class="game-modal-info">
                <h2 class="game-modal-title">${escapeHTML(fallback.title)}</h2>
                <p>Не вдалося завантажити інформацію про гру.</p>

                <a class="steam-btn"
                   href="${escapeHTML(fallback.steamURL)}"
                   target="_blank"
                   rel="noopener noreferrer">
                    Відкрити у Steam
                </a>
            </div>
        `;

        return;
    }

    const genres = details.genres.length
        ? details.genres.map(genre =>
            `<span class="game-genre">${escapeHTML(genre)}</span>`
        ).join("")
        : "Жанри не вказані";

    const screenshots = (details.screenshots || [])
        .map((screenshot, index) => `
            <a class="game-screenshot-link"
               href="${escapeHTML(screenshot.full)}"
               target="_blank"
               rel="noopener noreferrer"
               aria-label="Відкрити скріншот ${index + 1}">
                <img class="game-screenshot"
                     src="${escapeHTML(screenshot.thumbnail)}"
                     alt="Скріншот ${index + 1}"
                     loading="lazy">
            </a>
        `)
        .join("");

    const trailer = (details.movies || [])
        .find(movie => movie.mp4 || movie.webm);

    const trailerHTML = trailer ? `
        <section class="game-modal-section">
            <h3>Трейлер</h3>

            <video class="game-trailer"
                   controls
                   preload="metadata"
                   poster="${escapeHTML(trailer.thumbnail)}">
                ${trailer.mp4
                    ? `<source src="${escapeHTML(trailer.mp4)}" type="video/mp4">`
                    : ""
                }

                ${trailer.webm
                    ? `<source src="${escapeHTML(trailer.webm)}" type="video/webm">`
                    : ""
                }

                Ваш браузер не підтримує відтворення відео.
            </video>
        </section>
    ` : "";

    const screenshotsHTML = screenshots ? `
        <section class="game-modal-section">
            <h3>Скріншоти</h3>
            <div class="game-screenshots">${screenshots}</div>
        </section>
    ` : "";

    ELEMENTS.modalBody.innerHTML = `
        <div class="game-modal-layout">
            <img class="game-modal-poster modal-image"
                 src="${escapeHTML(details.headerImage)}"
                 alt="${escapeHTML(details.name)}">

            <div class="game-modal-info">
                <h2 class="game-modal-title">${escapeHTML(details.name)}</h2>

                <p class="game-modal-desc">
                    ${escapeHTML(
                        details.shortDescription ||
                        details.description ||
                        "Опис відсутній."
                    )}
                </p>

                <div class="game-genres">${genres}</div>

                <p><strong>Ціна:</strong> ${escapeHTML(details.price)}</p>
                <p><strong>Дата виходу:</strong> ${escapeHTML(details.releaseDate)}</p>

                <p>
                    <strong>Розробник:</strong>
                    ${escapeHTML(details.developers.join(", ") || "Не вказано")}
                </p>

                <p>
                    <strong>Видавець:</strong>
                    ${escapeHTML(details.publishers.join(", ") || "Не вказано")}
                </p>

                <a class="steam-btn"
                   href="${escapeHTML(details.steamURL)}"
                   target="_blank"
                   rel="noopener noreferrer">
                    Відкрити у Steam
                </a>
            </div>
        </div>

        ${screenshotsHTML}
        ${trailerHTML}
    `;

    ELEMENTS.modalBody
        .querySelectorAll(".game-screenshot")
        .forEach(image => {
            image.addEventListener("error", () => {
                image.closest(".game-screenshot-link")?.remove();
            }, { once: true });
        });
}

async function openGameModal(appId) {
    const modalRequestId = ++state.modalRequestId;

    const game = state.games.find(item => item.appId === appId) || {
        appId,
        title: "Гра",
        steamURL: `${CONFIG.steamStore}/app/${appId}/`
    };

    openModal();
    renderModalLoading(game.title);

    try {
        let details = state.detailCache.get(appId);

        if (details === undefined) {
            let promise = state.detailPromises.get(appId);

            if (!promise) {
               
                if (state.queuedDetailIds.has(appId)) {
                    state.queuedDetailIds.delete(appId);
                    state.detailQueue = state.detailQueue.filter(
                        id => id !== appId
                    );
                }

                promise = fetchGameDetails(appId)
                    .then(result => {
                        state.detailCache.set(appId, result);
                        updateCardDetails(appId, result);
                        return result;
                    })
                    .catch(error => {
                        state.detailCache.set(appId, null);
                        throw error;
                    })
                    .finally(() => {
                        state.detailPromises.delete(appId);
                    });

                state.detailPromises.set(appId, promise);
            }

            details = await promise;
        }

       
       
        if (modalRequestId !== state.modalRequestId) return;

        renderModalDetails(details, game);
    } catch (error) {
        if (modalRequestId !== state.modalRequestId) return;

        console.error(
            "Помилка завантаження інформації про гру:",
            error
        );

        renderModalDetails(null, game);
    }
}

function closeFilterMenus() {
    document.querySelectorAll(".gamehub-filter-menu").forEach(menu => {
        menu.remove();
    });
}

function createFilterMenu(
    button,
    className,
    options,
    selectedValue,
    onSelect
) {
    if (!button) return;

    const existing = button.parentElement
        ?.querySelector(`.${className}`);

    if (existing) {
        existing.remove();
        return;
    }

    closeFilterMenus();

    const menu = document.createElement("div");

    menu.className = `gamehub-filter-menu ${className}`;
    menu.setAttribute("role", "menu");

    for (const option of options) {
        const item = document.createElement("button");

        item.type = "button";
        item.className = "gamehub-filter-option";
        item.textContent = option.label;
        item.setAttribute("role", "menuitem");

        if (option.value === selectedValue) {
            item.classList.add("selected");
        }

        item.addEventListener("click", () => {
            onSelect(option.value);
            closeFilterMenus();
        });

        menu.appendChild(item);
    }

    const parent = button.parentElement;

    if (parent) {
        if (!parent.style.position) {
            parent.style.position = "relative";
        }

        parent.appendChild(menu);
    }
}

function initFilterMenus() {
    const genreOptions = [
        { value: "", label: "Усі жанри" },
        ...Object.entries(GENRES).map(([value, genre]) => ({
            value,
            label: genre.label
        }))
    ];

    const categoryOptions = [
        { value: "", label: "Усі ігри" },
        { value: "popular", label: "Популярні" },
        { value: "positive", label: "Високий рейтинг" },
        { value: "free", label: "Безкоштовні" }
    ];

    ELEMENTS.genresBtn?.addEventListener("click", event => {
        event.preventDefault();

        createFilterMenu(
            ELEMENTS.genresBtn,
            "genre-menu",
            genreOptions,
            state.selectedGenre,
            value => {
                state.selectedGenre = value;
                resetSearch();
            }
        );
    });

    ELEMENTS.categoryBtn?.addEventListener("click", event => {
        event.preventDefault();

        createFilterMenu(
            ELEMENTS.categoryBtn,
            "category-menu",
            categoryOptions,
            state.selectedCategory,
            value => {
                state.selectedCategory = value;
                resetSearch();
            }
        );
    });

    document.addEventListener("click", event => {
        if (
            !event.target.closest(".gamehub-filter-menu") &&
            !event.target.closest("#genresBtn") &&
            !event.target.closest("#categoryBtn")
        ) {
            closeFilterMenus();
        }
    });
}

function init() {
    if (!ELEMENTS.gamesGrid) {
        console.error("GAMEHUB: не знайдено елемент #gamesGrid.");
        return;
    }

    ELEMENTS.searchBtn?.addEventListener("click", resetSearch);

    ELEMENTS.searchInput?.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            resetSearch();
        }
    });

    ELEMENTS.modalClose?.addEventListener("click", closeModal);

    ELEMENTS.modal?.addEventListener("click", event => {
        if (event.target === ELEMENTS.modal) {
            closeModal();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeModal();
            closeFilterMenus();
        }
    });

    window.addEventListener("scroll", onScroll, { passive: true });

    initFilterMenus();
    resetSearch();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
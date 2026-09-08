import { Actor } from 'apify';

interface Input {
    githubToken?: string;
    pageSize?: number;
    maxNewProfiles?: number;
    maxPages?: number;
}

interface SponsorableNode {
    __typename: 'User' | 'Organization';
    login: string;
    name: string | null;
    url: string;
    bio?: string | null;
    description?: string | null;
    websiteUrl: string | null;
    twitterUsername: string | null;
    company?: string | null;
    location: string | null;
    email: string | null;
}

interface SponsorablesResponse {
    data?: {
        sponsorables: {
            nodes: SponsorableNode[];
            pageInfo: {
                hasNextPage: boolean;
                endCursor: string | null;
            };
            totalCount: number;
        };
    };
    errors?: { message: string }[];
}

interface ProfileRecord {
    username: string;
    profileLink: string;
    bio: string;
    links: string[];
}

interface RunState {
    cursor: string | null;
    donePages: number;
}

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const STATE_KEY = 'GITHUB_SPONSORS_STATE';
const STATE_STORE_NAME = 'github-sponsors-progress';

// Paste your own GitHub personal access token here between the backticks, a
// token with no scopes ticked at all is enough, since this only ever reads
// data that is already public. Leave the placeholder as is to require the
// githubToken input field instead.
const EMBEDDED_GITHUB_TOKEN = `PASTE_YOUR_GITHUB_TOKEN_HERE`;

const SPONSORABLES_QUERY = `
query SponsorablesPage($first: Int!, $after: String) {
  sponsorables(first: $first, after: $after) {
    totalCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      __typename
      ... on User {
        login
        name
        url
        bio
        websiteUrl
        twitterUsername
        company
        location
        email
      }
      ... on Organization {
        login
        name
        url
        description
        websiteUrl
        twitterUsername
        location
        email
      }
    }
  }
}
`;

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function resolveToken(inputToken: string | undefined): string {
    if (inputToken && inputToken.trim()) {
        return inputToken.trim();
    }

    const embedded = EMBEDDED_GITHUB_TOKEN.trim();

    if (!embedded || embedded === 'PASTE_YOUR_GITHUB_TOKEN_HERE') {
        throw new Error(
            'No GitHub token was supplied in the input, and none is embedded in ' +
                'the source yet. Either fill in the githubToken input field, or ' +
                'paste a real token into EMBEDDED_GITHUB_TOKEN in main.ts.',
        );
    }

    return embedded;
}

function buildLinks(node: SponsorableNode): string[] {
    const links = new Set<string>();

    if (node.websiteUrl) links.add(node.websiteUrl);
    if (node.twitterUsername) links.add(`https://twitter.com/${node.twitterUsername}`);
    if (node.email) links.add(`mailto:${node.email}`);

    return Array.from(links);
}

function buildRecord(node: SponsorableNode): ProfileRecord {
    const bio = node.__typename === 'Organization' ? node.description : node.bio;

    return {
        username: node.login,
        profileLink: node.url,
        bio: bio ?? '',
        links: buildLinks(node),
    };
}

async function fetchSponsorablesPage(
    token: string,
    pageSize: number,
    afterCursor: string | null,
): Promise<SponsorablesResponse['data']> {
    const response = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'GithubSponsorsProfileScraper (contact via Apify)',
        },
        body: JSON.stringify({
            query: SPONSORABLES_QUERY,
            variables: { first: pageSize, after: afterCursor },
        }),
    });

    if (!response.ok) {
        throw new Error(`GitHub GraphQL request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as SponsorablesResponse;

    if (payload.errors && payload.errors.length > 0) {
        throw new Error(`GitHub GraphQL returned errors: ${payload.errors.map((e) => e.message).join('; ')}`);
    }

    if (!payload.data) {
        throw new Error('GitHub GraphQL response had no data.');
    }

    return payload.data;
}

async function loadState(): Promise<RunState> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    const saved = await store.getValue<RunState>(STATE_KEY);

    if (saved) {
        return saved;
    }

    return { cursor: null, donePages: 0 };
}

async function saveState(state: RunState): Promise<void> {
    const store = await Actor.openKeyValueStore(STATE_STORE_NAME);
    await store.setValue(STATE_KEY, state);
}

await Actor.init();

try {
    const input = (await Actor.getInput<Input>()) ?? {};

    const token = resolveToken(input.githubToken);
    const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 50));
    const maxNewProfiles = Math.max(0, input.maxNewProfiles ?? 0);
    const maxPages = Math.max(0, input.maxPages ?? 0);

    const state = await loadState();

    console.log('==============================');
    console.log('GITHUB SPONSORS PROFILE SCRAPER');
    console.log('==============================');
    console.log(`Resuming from cursor: ${state.cursor ?? 'the very beginning'}`);
    console.log(`Pages already completed: ${state.donePages}`);
    console.log(`Page size: ${pageSize}`);
    console.log(`Max new profiles this run: ${maxNewProfiles === 0 ? 'UNLIMITED' : maxNewProfiles}`);
    console.log(`Max pages this run: ${maxPages === 0 ? 'UNLIMITED' : maxPages}`);

    let cursor = state.cursor;
    let pagesThisRun = 0;
    let savedThisRun = 0;
    let hasNextPage = true;
    let totalCount: number | null = null;

    while (hasNextPage) {
        if (maxPages > 0 && pagesThisRun >= maxPages) {
            console.log(`Reached configured page limit: ${maxPages}.`);
            break;
        }

        if (maxNewProfiles > 0 && savedThisRun >= maxNewProfiles) {
            console.log(`Reached configured new profile limit: ${maxNewProfiles}.`);
            break;
        }

        let pageData;

        try {
            pageData = await fetchSponsorablesPage(token, pageSize, cursor);
        } catch (error) {
            console.log(`Page fetch failed, will retry this same page next run: ${errorMessage(error)}`);
            break;
        }

        totalCount = pageData!.sponsorables.totalCount;

        console.log(
            `\nPage ${state.donePages + pagesThisRun + 1}: ${pageData!.sponsorables.nodes.length} profile(s) ` +
                `(total sponsorable accounts on GitHub: ${totalCount})`,
        );

        for (const node of pageData!.sponsorables.nodes) {
            const record = buildRecord(node);
            await Actor.pushData(record);
            savedThisRun++;
            console.log(`SAVED: ${record.username} (${record.links.length} link(s))`);

            if (maxNewProfiles > 0 && savedThisRun >= maxNewProfiles) {
                break;
            }
        }

        cursor = pageData!.sponsorables.pageInfo.endCursor;
        hasNextPage = pageData!.sponsorables.pageInfo.hasNextPage;
        pagesThisRun++;

        // Save progress after every page, not just at the end, so a run that
        // stops partway through never has to repeat work already done.
        await saveState({ cursor, donePages: state.donePages + pagesThisRun });
    }

    console.log('\n==============================');
    console.log('RUN FINISHED');
    console.log('==============================');
    console.log(`Pages fetched this run: ${pagesThisRun}`);
    console.log(`Profiles saved this run: ${savedThisRun}`);
    console.log(
        hasNextPage
            ? `Stopped with more still to go. Run again to continue from cursor: ${cursor}`
            : 'Reached the end of the list. Nothing left to walk forward through.',
    );
} catch (error) {
    console.error(`FATAL ACTOR ERROR: ${errorMessage(error)}`);
    throw error;
} finally {
    await Actor.exit();
}

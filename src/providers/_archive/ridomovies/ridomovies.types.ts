export interface Content {
    id: string;
    type: string;
    slug: string;
    title: string;
    metaTitle: string | null;
    metaDescription: string | null;
    usersOnly: boolean;
    userLevel: number;
    vipOnly: boolean;
    copyrighted: boolean;
    status: string;
    publishedAt: string;
    createdAt: string;
    updatedAt: string;
    fullSlug: string;
}

export interface Contentable {
    id: string;
    contentId: string;
    revisionId: string | null;
    originalTitle: string;
    overview: string;
    releaseDate: string;
    releaseYear: string;
    videoNote: string | null;
    posterNote: string | null;
    userRating: number;
    imdbRating: number;
    imdbVotes: number;
    imdbId: string;
    duration: number;
    countryCode: string;
    posterPath: string;
    backdropPath: string;
    apiPosterPath: string;
    apiBackdropPath: string;
    trailerUrl: string;
    mpaaRating: string;
    tmdbId: number;
    manual: number;
    directorId: number;
    createdAt: string;
    updatedAt: string;
    content: Content;
}

export interface SearchResultItem {
    id: string;
    type: string;
    slug: string;
    title: string;
    metaTitle: string | null;
    metaDescription: string | null;
    usersOnly: boolean;
    userLevel: number;
    vipOnly: boolean;
    copyrighted: boolean;
    status: string;
    publishedAt: string;
    createdAt: string;
    updatedAt: string;
    fullSlug: string;
    contentable: Contentable;
}

export interface SearchResult {
    data: {
        items: SearchResultItem[];
    };
}

export interface IframeSourceResult {
    data: {
        url: string;
    }[];
}

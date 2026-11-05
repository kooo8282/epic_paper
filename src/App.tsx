import React, { useState, useCallback, useMemo } from 'react';
import { Search, Download, Trash2, FileText, CheckCircle2, XCircle, Loader2, AlertCircle, Filter, Calendar } from 'lucide-react';

export type SearchSourceType = 'Both' | 'Funding' | 'Author';

export interface Publication {
  id: string; // Scopus EID or ID
  scopusId: string;
  title: string;
  authors: string;
  date: string;
  journal: string;
  doi: string;
  issns?: string[];
  searchSource: SearchSourceType;
  matchedFundingNumbers: string[];
  matchedAuthorIds: string[];
  publicationYear?: number;
  status: 'success' | 'error' | 'not_found';
  errorMsg?: string;
  flaggedForReview?: boolean;
}

export interface SearchTaskResult {
  condition: string;
  type: 'funding' | 'author';
  success: boolean;
  totalFound: number;
  retrievedCount: number;
  incomplete: boolean;
  error?: string;
}

// DOI normalizer: removes https://doi.org/, http://dx.doi.org/, converts to lowercase, trims whitespace
export function normalizeDoi(rawDoi?: string): string {
  if (!rawDoi) return '';
  let doi = rawDoi.trim().toLowerCase();
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  doi = doi.replace(/^\/+/, '');
  return doi.trim();
}

// Scopus ID normalizer
export function normalizeScopusId(rawId?: string): string {
  if (!rawId) return '';
  let id = rawId.trim();
  if (id.startsWith('SCOPUS_ID:')) {
    id = id.substring('SCOPUS_ID:'.length).trim();
  }
  return id;
}

// Title normalizer: lowercases, strips special characters, spaces
export function normalizeTitle(rawTitle?: string): string {
  if (!rawTitle) return '';
  return rawTitle
    .toLowerCase()
    .replace(/<[^>]+>/g, '') // remove HTML tags
    .replace(/&[a-z0-9#]+;/gi, '') // remove HTML entities
    .replace(/[^a-z0-9가-힣]/g, '')
    .trim();
}

// Clean HTML formatting & entity codes in text
export function cleanText(str?: string): string {
  if (!str) return '';
  const noTags = str.replace(/<\/?[^>]+(>|$)/g, '');
  try {
    const doc = new DOMParser().parseFromString(noTags, 'text/html');
    return doc.documentElement.textContent || noTags;
  } catch {
    return noTags;
  }
}

// Extract 4-digit publication year
export function extractYear(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const match = dateStr.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

// In-memory cache for search responses during session
// Key: query + count + start + view
const apiResponseCache = new Map<string, any>();

// Concurrency pool runner
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrencyLimit = 3
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < tasks.length) {
      const idx = currentIndex++;
      try {
        const val = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value: val };
      } catch (err: any) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrencyLimit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Session-level tracking of COMPLETE view support for Scopus API key (default false for developer keys)
let globalCompleteViewSupported = false;

// Fetch single Scopus page through /api/scopus with rate limit handling, backoff, and caching
async function fetchScopusPage(
  query: string,
  start: number,
  count = 25,
  useCompleteView = false,
  maxRetries = 3
): Promise<{ data: any; usedCompleteView: boolean }> {
  let attempt = 0;
  let currentUseComplete = useCompleteView && globalCompleteViewSupported;

  const cacheKey = `${query}|${start}|${count}|${currentUseComplete ? 'C' : 'S'}`;
  if (apiResponseCache.has(cacheKey)) {
    return { data: apiResponseCache.get(cacheKey), usedCompleteView: currentUseComplete };
  }

  while (attempt <= maxRetries) {
    const params = new URLSearchParams({
      query,
      count: String(count),
      start: String(start),
      view: currentUseComplete ? 'COMPLETE' : 'STANDARD',
    });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 18000);

      const response = await fetch(`/api/scopus?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Handle view=COMPLETE fallback on 401/400/403/500 if complete view is rejected or unauthorized
      if (!response.ok && currentUseComplete && (response.status === 401 || response.status === 400 || response.status === 403 || response.status === 500)) {
        currentUseComplete = false;
        globalCompleteViewSupported = false;
        continue;
      }

      // Handle Rate Limiting (429) & Transient 5xx
      if (response.status === 429 || (response.status >= 500 && response.status <= 504)) {
        if (attempt >= maxRetries) {
          const rawErr = await response.text().catch(() => '');
          let detail = rawErr;
          try {
            const parsed = JSON.parse(rawErr);
            if (parsed.error === 'System Error Occurred' || parsed.error?.includes('System Error')) {
              detail = 'Elsevier Scopus 서버 일시적 장애 (System Error Occurred) - 잠시 후 다시 시도해 주세요.';
            } else if (parsed.error) {
              detail = parsed.error;
            }
          } catch {
            // rawErr
          }
          throw new Error(`Scopus API 오류 (${response.status}): ${detail}`);
        }

        // Check Retry-After header
        const retryAfterHeader = response.headers.get('Retry-After');
        let delayMs = 1200 * Math.pow(2, attempt); // 1.2s, 2.4s, 4.8s
        if (retryAfterHeader) {
          const parsedSeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsedSeconds) && parsedSeconds > 0 && parsedSeconds <= 15) {
            delayMs = parsedSeconds * 1000;
          }
        }

        attempt++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        let errorDetail = response.statusText;
        try {
          const errJson: any = await response.json();
          errorDetail = errJson?.error || errJson?.['service-error']?.status?.statusText || JSON.stringify(errJson);
          if (errorDetail === 'System Error Occurred') {
            errorDetail = 'Elsevier Scopus 서버 일시적 장애 (System Error Occurred) - 잠시 후 다시 시도해 주세요.';
          }
        } catch {
          // ignore json parse error
        }
        throw new Error(`Scopus API 오류 (${response.status}): ${errorDetail}`);
      }

      const data = await response.json();
      apiResponseCache.set(cacheKey, data);
      return { data, usedCompleteView: currentUseComplete };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (attempt < maxRetries) {
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        throw new Error('Request timed out while connecting to Scopus API.');
      }
      if (attempt < maxRetries && err.message?.includes('network')) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }

  throw new Error('Maximum retry attempts exceeded while calling Scopus API.');
}

// Fetch all results for a single query, respecting Scopus 5,000 pagination window limit
// If total exceeds 5,000, mark incomplete or partition by year
async function fetchAllResultsForQuery(
  baseQuery: string,
  onProgress?: (fetched: number, total: number) => void
): Promise<{ entries: any[]; totalResults: number; incomplete: boolean; error?: string }> {
  let allEntries: any[] = [];
  let start = 0;
  const count = 25;
  let totalResults = 0;
  let useCompleteView = false;
  let isFirst = true;
  let incomplete = false;

  const MAX_SCOPUS_WINDOW = 5000;

  while (start < MAX_SCOPUS_WINDOW) {
    const { data, usedCompleteView } = await fetchScopusPage(baseQuery, start, count, useCompleteView);
    useCompleteView = usedCompleteView;

    if (isFirst) {
      totalResults = parseInt(data['search-results']?.['opensearch:totalResults'] || '0', 10);
      isFirst = false;
    }

    const entries = data['search-results']?.entry || [];
    if (entries.length === 0) break;

    allEntries = allEntries.concat(entries);
    start += count;

    if (onProgress) {
      onProgress(allEntries.length, totalResults);
    }

    if (start >= totalResults) break;

    // Small polite pause to prevent flooding
    await new Promise((r) => setTimeout(r, 120));
  }

  if (totalResults > MAX_SCOPUS_WINDOW && allEntries.length < totalResults) {
    incomplete = true;
  }

  return {
    entries: allEntries,
    totalResults,
    incomplete,
  };
}

// Convert Scopus entry object to intermediate publication data
function parseScopusEntry(entry: any, conditionValue: string, conditionType: 'funding' | 'author') {
  const scopusId = normalizeScopusId(entry['dc:identifier'] || entry['eid'] || '');
  const doi = normalizeDoi(entry['prism:doi'] || '');
  const title = cleanText(entry['dc:title'] || 'Untitled Document');
  const date = entry['prism:coverDate'] || '';
  const journal = cleanText(entry['prism:publicationName'] || '');
  const publicationYear = extractYear(date);

  // Author string extraction
  let authors = '';
  if (entry.author && Array.isArray(entry.author)) {
    authors = entry.author
      .map((a: any) => `${a.given_name || a['given-name'] || ''} ${a.surname || ''}`.trim() || a.authname || '')
      .filter(Boolean)
      .join(', ');
  } else if (entry['dc:creator']) {
    authors = cleanText(entry['dc:creator']);
  }

  const issns: string[] = [entry['prism:issn'], entry['prism:eIssn']].filter(Boolean);

  return {
    scopusId,
    doi,
    title,
    authors,
    date,
    journal,
    publicationYear,
    issns,
    matchedFunding: conditionType === 'funding' ? [conditionValue] : [],
    matchedAuthor: conditionType === 'author' ? [conditionValue] : [],
  };
}

export default function App() {
  // Input states
  const [fundingNumber, setFundingNumber] = useState(() => localStorage.getItem('savedFundingNumber') || '');
  const [authorId, setAuthorId] = useState(() => localStorage.getItem('savedAuthorId') || '');
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');

  // Search state
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [activeTaskName, setActiveTaskName] = useState('');
  const [searchTasks, setSearchTasks] = useState<SearchTaskResult[]>([]);
  const [hasIncompleteResults, setHasIncompleteResults] = useState(false);

  // Publications state
  const [publications, setPublications] = useState<Publication[]>([]);

  // Filter state
  const [sourceFilter, setSourceFilter] = useState<'All' | 'Both' | 'Funding' | 'Author'>('All');

  // Summary counts
  const summaryCounts = useMemo(() => {
    let both = 0;
    let fundingOnly = 0;
    let authorOnly = 0;

    for (const pub of publications) {
      if (pub.searchSource === 'Both') both++;
      else if (pub.searchSource === 'Funding') fundingOnly++;
      else if (pub.searchSource === 'Author') authorOnly++;
    }

    return {
      total: publications.length,
      both,
      fundingOnly,
      authorOnly,
    };
  }, [publications]);

  // Filtered publications for table view
  const filteredPublications = useMemo(() => {
    if (sourceFilter === 'All') return publications;
    return publications.filter((p) => p.searchSource === sourceFilter);
  }, [publications, sourceFilter]);

  // Perform search across all unique funding numbers and author IDs
  const executeSearch = async () => {
    // 1. Normalize and deduplicate search inputs
    const fNums: string[] = Array.from(
      new Set(
        fundingNumber
          .split(/[\n,;]+/)
          .map((n) => n.trim())
          .filter(Boolean)
      )
    );
    const aIds: string[] = Array.from(
      new Set(
        authorId
          .split(/[\n,;]+/)
          .map((n) => n.trim())
          .filter(Boolean)
      )
    );

    if (fNums.length === 0 && aIds.length === 0) return;

    localStorage.setItem('savedFundingNumber', fundingNumber.trim());
    localStorage.setItem('savedAuthorId', authorId.trim());

    setIsProcessing(true);
    setPublications([]);
    setSearchTasks([]);
    setHasIncompleteResults(false);

    // List of independent query tasks
    interface QuerySpec {
      id: string;
      value: string;
      type: 'funding' | 'author';
      queryString: string;
    }

    const querySpecs: QuerySpec[] = [];

    // Date range clause
    let dateClause = '';
    if (startMonth.trim() || endMonth.trim()) {
      const sYear = startMonth ? startMonth.split('-')[0] : '1950';
      const eYear = endMonth ? endMonth.split('-')[0] : '2050';
      dateClause = ` AND PUBYEAR > ${parseInt(sYear, 10) - 1} AND PUBYEAR < ${parseInt(eYear, 10) + 1}`;
    }

    for (const fn of fNums) {
      querySpecs.push({
        id: `FUND-NO:${fn}`,
        value: fn,
        type: 'funding',
        queryString: `FUND-NO("${fn}")${dateClause}`,
      });
    }

    for (const aid of aIds) {
      querySpecs.push({
        id: `AU-ID:${aid}`,
        value: aid,
        type: 'author',
        queryString: `AU-ID(${aid})${dateClause}`,
      });
    }

    setProgress({ completed: 0, total: querySpecs.length });

    // Indexed map for fast O(1) deduplication & incremental merge
    const pubKeyToId = new Map<string, string>(); // indexed by doi, scopusId, and normTitle+year
    const mergedPubs = new Map<string, Publication>();

    const taskResults: SearchTaskResult[] = [];
    let completedCount = 0;
    let anyIncomplete = false;

    // Helper to merge a newly retrieved entry into mergedPubs
    const mergeEntry = (rawEntry: any, conditionValue: string, conditionType: 'funding' | 'author') => {
      const parsed = parseScopusEntry(rawEntry, conditionValue, conditionType);
      const cleanDoi = parsed.doi;
      const cleanScopusId = parsed.scopusId;
      const cleanNormTitle = normalizeTitle(parsed.title);
      const year = parsed.publicationYear;

      // 1. Resolve matching record key
      let matchedPrimaryId: string | undefined;

      if (cleanDoi && pubKeyToId.has(`doi:${cleanDoi}`)) {
        matchedPrimaryId = pubKeyToId.get(`doi:${cleanDoi}`);
      } else if (cleanScopusId && pubKeyToId.has(`scopus:${cleanScopusId}`)) {
        matchedPrimaryId = pubKeyToId.get(`scopus:${cleanScopusId}`);
      } else if (cleanNormTitle.length >= 8 && year && pubKeyToId.has(`title:${cleanNormTitle}|${year}`)) {
        matchedPrimaryId = pubKeyToId.get(`title:${cleanNormTitle}|${year}`);
      }

      if (matchedPrimaryId && mergedPubs.has(matchedPrimaryId)) {
        // Merge into existing record
        const existing = mergedPubs.get(matchedPrimaryId)!;

        // Merge sources & matched search conditions
        const fundingSet = new Set([...existing.matchedFundingNumbers, ...parsed.matchedFunding]);
        const authorSet = new Set([...existing.matchedAuthorIds, ...parsed.matchedAuthor]);

        const hasFunding = fundingSet.size > 0;
        const hasAuthor = authorSet.size > 0;
        const newSource: SearchSourceType = hasFunding && hasAuthor ? 'Both' : hasFunding ? 'Funding' : 'Author';

        // Keep most complete metadata (never overwrite valid info with empty/unknown)
        const bestTitle =
          parsed.title && parsed.title !== 'Untitled Document' && (!existing.title || existing.title === 'Untitled Document')
            ? parsed.title
            : existing.title;
        const bestAuthors =
          parsed.authors && parsed.authors.length > (existing.authors?.length || 0) ? parsed.authors : existing.authors;
        const bestJournal = parsed.journal && !existing.journal ? parsed.journal : existing.journal;
        const bestDate = parsed.date && !existing.date ? parsed.date : existing.date;
        const bestDoi = cleanDoi && !existing.doi ? cleanDoi : existing.doi;
        const mergedIssns = Array.from(new Set([...(existing.issns || []), ...(parsed.issns || [])]));

        mergedPubs.set(matchedPrimaryId, {
          ...existing,
          title: bestTitle,
          authors: bestAuthors,
          journal: bestJournal,
          date: bestDate,
          doi: bestDoi,
          issns: mergedIssns,
          searchSource: newSource,
          matchedFundingNumbers: Array.from(fundingSet),
          matchedAuthorIds: Array.from(authorSet),
        });

        // Register any new keys pointing to this record
        if (cleanDoi) pubKeyToId.set(`doi:${cleanDoi}`, matchedPrimaryId);
        if (cleanScopusId) pubKeyToId.set(`scopus:${cleanScopusId}`, matchedPrimaryId);
        if (cleanNormTitle.length >= 8 && year) pubKeyToId.set(`title:${cleanNormTitle}|${year}`, matchedPrimaryId);
      } else {
        // Create new record
        const primaryId = cleanScopusId ? `SCOPUS_ID:${cleanScopusId}` : cleanDoi ? `DOI:${cleanDoi}` : `PUB_${mergedPubs.size + 1}`;
        const initialSource: SearchSourceType = conditionType === 'funding' ? 'Funding' : 'Author';

        const newRecord: Publication = {
          id: primaryId,
          scopusId: cleanScopusId,
          title: parsed.title,
          authors: parsed.authors,
          date: parsed.date,
          journal: parsed.journal,
          doi: cleanDoi,
          issns: parsed.issns,
          searchSource: initialSource,
          matchedFundingNumbers: parsed.matchedFunding,
          matchedAuthorIds: parsed.matchedAuthor,
          publicationYear: year,
          status: 'success',
        };

        mergedPubs.set(primaryId, newRecord);

        // Index the record
        if (cleanDoi) pubKeyToId.set(`doi:${cleanDoi}`, primaryId);
        if (cleanScopusId) pubKeyToId.set(`scopus:${cleanScopusId}`, primaryId);
        if (cleanNormTitle.length >= 8 && year) pubKeyToId.set(`title:${cleanNormTitle}|${year}`, primaryId);
      }
    };

    // Construct concurrency tasks
    const tasks = querySpecs.map((spec) => async () => {
      setActiveTaskName(`${spec.type === 'funding' ? 'Funding Number' : 'Author ID'}: ${spec.value}`);
      try {
        const result = await fetchAllResultsForQuery(spec.queryString);
        if (result.incomplete) anyIncomplete = true;

        // Apply month range filter locally if specified
        let filteredEntries = result.entries;
        if (startMonth || endMonth) {
          const sMonthStr = startMonth || '1900-01';
          const eMonthStr = endMonth || '2999-12';
          filteredEntries = result.entries.filter((entry: any) => {
            const coverDate = entry['prism:coverDate']; // YYYY-MM-DD
            if (!coverDate) return true;
            const entryMonth = coverDate.substring(0, 7);
            return entryMonth >= sMonthStr && entryMonth <= eMonthStr;
          });
        }

        // Merge entries into central collection
        for (const entry of filteredEntries) {
          mergeEntry(entry, spec.value, spec.type);
        }

        taskResults.push({
          condition: spec.value,
          type: spec.type,
          success: true,
          totalFound: result.totalResults,
          retrievedCount: filteredEntries.length,
          incomplete: result.incomplete,
        });
      } catch (err: any) {
        taskResults.push({
          condition: spec.value,
          type: spec.type,
          success: false,
          totalFound: 0,
          retrievedCount: 0,
          incomplete: false,
          error: err.message || 'Search failed',
        });
      } finally {
        completedCount++;
        setProgress({ completed: completedCount, total: querySpecs.length });
        setSearchTasks([...taskResults]);
        setPublications(Array.from(mergedPubs.values()));
      }
    });

    // Execute with conservative concurrency limit of 3
    await runWithConcurrency(tasks, 3);

    setHasIncompleteResults(anyIncomplete);
    setIsProcessing(false);
    setActiveTaskName('');
  };

  // CSV Export
  const exportCSV = useCallback(() => {
    if (publications.length === 0) return;

    // Ordered columns per requirement:
    // 1. Scopus ID
    // 2. Title
    // 3. Authors
    // 4. Publication Date
    // 5. Journal
    // 6. DOI
    // 7. Search Source
    // 8. Matched Funding Number(s)
    // 9. Matched Author ID(s)
    const headers = [
      'Scopus ID',
      'Title',
      'Authors',
      'Publication Date',
      'Journal',
      'DOI',
      'Search Source',
      'Matched Funding Number(s)',
      'Matched Author ID(s)',
    ];

    const escapeCsv = (val?: string | number) => {
      if (val === undefined || val === null) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvRows = publications.map((p) => [
      escapeCsv(p.scopusId || p.id),
      escapeCsv(p.title),
      escapeCsv(p.authors),
      escapeCsv(p.date),
      escapeCsv(p.journal),
      escapeCsv(p.doi),
      escapeCsv(p.searchSource),
      escapeCsv(p.matchedFundingNumbers.join('; ')),
      escapeCsv(p.matchedAuthorIds.join('; ')),
    ]);

    const csvContent = [headers.map((h) => `"${h}"`).join(','), ...csvRows.map((r) => r.join(','))].join('\r\n');

    // UTF-8 BOM (\uFEFF) for Excel compatibility
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `scopus_publications_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [publications]);

  const clearAll = () => {
    setFundingNumber('');
    setAuthorId('');
    setStartMonth('');
    setEndMonth('');
    setPublications([]);
    setSearchTasks([]);
    setProgress({ completed: 0, total: 0 });
    setHasIncompleteResults(false);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans text-slate-900 p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-slate-900 flex items-center gap-3">
              <FileText className="w-8 h-8 text-blue-600" />
              EPIC Paper Scopus Search
            </h1>
            <p className="text-slate-500 text-sm mt-1 max-w-2xl">
              RLRC 연구 과제 사사 논문 수집 및 저자 ID 기반 누락 논문 통합 검색 도구입니다.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Form Panel */}
          <div className="lg:col-span-4 space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 flex flex-col gap-4">
              {/* Funding Numbers */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label htmlFor="funding-input" className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Funding Number(s)
                  </label>
                  <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                    {fundingNumber.split(/[\n,;]+/).filter((l) => l.trim()).length}개
                  </span>
                </div>
                <textarea
                  id="funding-input"
                  value={fundingNumber}
                  onChange={(e) => setFundingNumber(e.target.value)}
                  placeholder="예: NRF-2021R1A2C1000000 (줄바꿈 또는 쉼표 구분)"
                  className="w-full resize-none h-[110px] rounded-xl border border-slate-200 p-3 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder:text-slate-400 placeholder:font-sans"
                  disabled={isProcessing}
                />
              </div>

              {/* Author IDs */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label htmlFor="author-input" className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Author ID(s)
                  </label>
                  <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                    {authorId.split(/[\n,;]+/).filter((l) => l.trim()).length}개
                  </span>
                </div>
                <textarea
                  id="author-input"
                  value={authorId}
                  onChange={(e) => setAuthorId(e.target.value)}
                  placeholder="예: 57209617104 (줄바꿈 또는 쉼표 구분)"
                  className="w-full resize-none h-[110px] rounded-xl border border-slate-200 p-3 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder:text-slate-400 placeholder:font-sans"
                  disabled={isProcessing}
                />
              </div>

              {/* Date Filters */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    Start Month (선택)
                  </label>
                  <input
                    type="month"
                    value={startMonth}
                    onChange={(e) => setStartMonth(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    disabled={isProcessing}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    End Month (선택)
                  </label>
                  <input
                    type="month"
                    value={endMonth}
                    onChange={(e) => setEndMonth(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    disabled={isProcessing}
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-2 flex gap-3">
                <button
                  onClick={executeSearch}
                  disabled={isProcessing || (!fundingNumber.trim() && !authorId.trim())}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      검색 중... ({progress.completed}/{progress.total})
                    </>
                  ) : (
                    <>
                      <Search className="w-4 h-4" />
                      논문 검색 실행
                    </>
                  )}
                </button>
                <button
                  onClick={clearAll}
                  disabled={isProcessing || (!fundingNumber && !authorId && publications.length === 0)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 p-3 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="모두 초기화"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>

              {/* Progress & Active Task info */}
              {isProcessing && activeTaskName && (
                <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 text-xs text-blue-700 space-y-1">
                  <div className="flex justify-between font-semibold">
                    <span>처리 중:</span>
                    <span>
                      {progress.completed} / {progress.total}
                    </span>
                  </div>
                  <div className="truncate text-blue-800">{activeTaskName}</div>
                </div>
              )}

              {/* Incomplete warning if any condition hit 5000 window limit */}
              {hasIncompleteResults && (
                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>일부 조건의 검색 결과가 5,000건을 초과하여 최대 상한까지만 수집되었습니다. 필요 시 기간(월)을 좁혀서 재검색해 주세요.</span>
                </div>
              )}

              {/* Task Results Breakdown */}
              {searchTasks.length > 0 && !isProcessing && (
                <div className="border-t border-slate-100 pt-3 space-y-2">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">조건별 검색 결과:</div>
                  <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {searchTasks.map((t, idx) => (
                      <div
                        key={idx}
                        className={`text-xs p-2.5 rounded-lg flex flex-col gap-1 ${
                          t.success ? 'bg-slate-50 text-slate-700' : 'bg-red-50 text-red-700 border border-red-100'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="truncate pr-2">
                            <span className="font-mono font-medium">{t.condition}</span>
                            <span className="text-[10px] text-slate-400 ml-1">({t.type === 'funding' ? '과제' : '저자'})</span>
                          </div>
                          <div className="shrink-0 font-medium">
                            {t.success ? `${t.retrievedCount}건` : '실패'}
                          </div>
                        </div>
                        {!t.success && t.error && (
                          <div className="text-[11px] text-red-600 font-sans break-words bg-red-100/50 p-1.5 rounded">
                            {t.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Results Panel */}
          <div className="lg:col-span-8 space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 flex flex-col h-[750px]">
              {/* Summary Cards Header */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <button
                  onClick={() => setSourceFilter('All')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    sourceFilter === 'All'
                      ? 'border-blue-600 bg-blue-50/50 ring-2 ring-blue-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="text-xs text-slate-500 font-medium">전체 고유 논문</div>
                  <div className="text-xl font-bold text-slate-900 mt-0.5">{summaryCounts.total.toLocaleString()}</div>
                </button>

                <button
                  onClick={() => setSourceFilter('Both')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    sourceFilter === 'Both'
                      ? 'border-emerald-600 bg-emerald-50/50 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="text-xs text-emerald-600 font-medium">Both (과제+저자)</div>
                  <div className="text-xl font-bold text-emerald-700 mt-0.5">{summaryCounts.both.toLocaleString()}</div>
                </button>

                <button
                  onClick={() => setSourceFilter('Funding')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    sourceFilter === 'Funding'
                      ? 'border-indigo-600 bg-indigo-50/50 ring-2 ring-indigo-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="text-xs text-indigo-600 font-medium">Funding only (과제)</div>
                  <div className="text-xl font-bold text-indigo-700 mt-0.5">{summaryCounts.fundingOnly.toLocaleString()}</div>
                </button>

                <button
                  onClick={() => setSourceFilter('Author')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    sourceFilter === 'Author'
                      ? 'border-amber-600 bg-amber-50/50 ring-2 ring-amber-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <div className="text-xs text-amber-600 font-medium">Author only (저자)</div>
                  <div className="text-xl font-bold text-amber-700 mt-0.5">{summaryCounts.authorOnly.toLocaleString()}</div>
                </button>
              </div>

              {/* Table Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Filter className="w-3.5 h-3.5" />
                  <span>필터:</span>
                  <span className="font-semibold text-slate-800">
                    {sourceFilter === 'All' ? '전체 보기' : sourceFilter}
                  </span>
                  <span className="text-slate-400">({filteredPublications.length}건 표시)</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={exportCSV}
                    disabled={publications.length === 0 || isProcessing}
                    className="text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white px-3.5 py-2 rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                  >
                    <Download className="w-3.5 h-3.5" />
                    CSV 내보내기 ({publications.length})
                  </button>
                </div>
              </div>

              {/* Table Body */}
              <div className="flex-1 overflow-auto border border-slate-100 rounded-xl mt-3">
                {publications.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-3">
                    <FileText className="w-12 h-12 opacity-20" />
                    <p className="text-sm font-medium">
                      {isProcessing ? 'Scopus에서 논문을 검색하고 있습니다...' : 'Funding Number 또는 Author ID를 입력 후 검색하세요.'}
                    </p>
                  </div>
                ) : filteredPublications.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-2">
                    <p className="text-sm">선택한 필터({sourceFilter})에 해당하는 논문이 없습니다.</p>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="bg-slate-50 sticky top-0 z-10 border-b border-slate-200">
                      <tr>
                        <th className="p-3 font-semibold text-slate-600">출처</th>
                        <th className="p-3 font-semibold text-slate-600 max-w-[280px]">논문 제목</th>
                        <th className="p-3 font-semibold text-slate-600 max-w-[200px]">저자</th>
                        <th className="p-3 font-semibold text-slate-600 whitespace-nowrap">발행일</th>
                        <th className="p-3 font-semibold text-slate-600 max-w-[180px]">학술지</th>
                        <th className="p-3 font-semibold text-slate-600">매칭 조건</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-sans">
                      {filteredPublications.map((pub, idx) => (
                        <tr key={pub.id || idx} className="hover:bg-slate-50/80 transition-colors">
                          {/* Search Source Badge */}
                          <td className="p-3 whitespace-nowrap">
                            {pub.searchSource === 'Both' && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Both
                              </span>
                            )}
                            {pub.searchSource === 'Funding' && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                                Funding
                              </span>
                            )}
                            {pub.searchSource === 'Author' && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                Author
                              </span>
                            )}
                          </td>

                          {/* Title & DOI */}
                          <td className="p-3 max-w-[280px]" title={pub.title}>
                            <div className="font-medium text-slate-900 line-clamp-2 leading-relaxed">{pub.title}</div>
                            {pub.doi && (
                              <a
                                href={`https://doi.org/${pub.doi}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-blue-600 hover:underline font-mono mt-0.5 inline-block truncate max-w-full"
                              >
                                {pub.doi}
                              </a>
                            )}
                          </td>

                          {/* Authors */}
                          <td className="p-3 max-w-[200px] text-slate-600 truncate" title={pub.authors}>
                            {pub.authors || <span className="text-slate-300">-</span>}
                          </td>

                          {/* Date */}
                          <td className="p-3 whitespace-nowrap text-slate-600 font-mono text-[11px]">
                            {pub.date || <span className="text-slate-300">-</span>}
                          </td>

                          {/* Journal */}
                          <td className="p-3 max-w-[180px] text-slate-600 truncate" title={pub.journal}>
                            {pub.journal || <span className="text-slate-300">-</span>}
                          </td>

                          {/* Matched Details */}
                          <td className="p-3 text-[11px]">
                            <div className="space-y-0.5">
                              {pub.matchedFundingNumbers.length > 0 && (
                                <div className="text-indigo-700 font-mono text-[10px] truncate max-w-[150px]" title={`과제: ${pub.matchedFundingNumbers.join(', ')}`}>
                                  과제: {pub.matchedFundingNumbers.join(', ')}
                                </div>
                              )}
                              {pub.matchedAuthorIds.length > 0 && (
                                <div className="text-amber-800 font-mono text-[10px] truncate max-w-[150px]" title={`저자: ${pub.matchedAuthorIds.join(', ')}`}>
                                  저자: {pub.matchedAuthorIds.join(', ')}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useCallback, useRef } from 'react';
import { Search, Download, Trash2, FileText, CheckCircle2, XCircle, Loader2, AlertCircle, Settings, Upload, Link } from 'lucide-react';
import * as xlsx from 'xlsx';

interface PaperInfo {
  id: string; // Original input or Scopus ID
  type: 'doi' | 'title' | 'funding';
  title: string;
  authors: string;
  date: string;
  journal: string;
  doi: string;
  status: 'pending' | 'success' | 'error' | 'not_found';
  errorMsg?: string;
  issns?: string[];
  topPercentile?: number;
  topSubjectArea?: string;
}

const isDOI = (str: string) => {
  return /^10.\d{4,9}\/[-._;()/:A-Z0-9]+$/i.test(str.trim());
};

const cleanText = (str: string) => {
  if (!str) return '';
  // Remove HTML tags (like <inf>3</inf>)
  const noTags = str.replace(/<\/?[^>]+(>|$)/g, "");
  // Decode HTML entities (like &amp; or &#xb7;)
  const doc = new DOMParser().parseFromString(noTags, "text/html");
  return doc.documentElement.textContent || "";
};

let jcrCache: { url: string; data: Record<string, { percentile: number; category: string }> } | null = null;

const formatUrlForDownload = (inputUrl: string): string => {
  let url = inputUrl.trim();
  // Support Google Drive links: convert sharing URL to direct download URL
  const gDriveMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (gDriveMatch && (url.includes('drive.google.com') || url.includes('docs.google.com'))) {
    const fileId = gDriveMatch[1];
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  // Support Dropbox links: change dl=0 to dl=1
  if (url.includes('dropbox.com') && url.includes('dl=0')) {
    return url.replace('dl=0', 'dl=1');
  }
  return url;
};

const parseJCRWorkbook = (buffer: ArrayBuffer | Uint8Array) => {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json<any[]>(sheet, { header: 1 });
  
  const map: Record<string, { percentile: number; category: string }> = {};
  
  // Find column indices by header if possible, else default to 9,10,11,17
  let catIdx = 9;
  let issnIdx = 10;
  let eissnIdx = 11;
  let jifRankIdx = 17;
  
  const headRow = data[0];
  if (Array.isArray(headRow)) {
    const cIdx = headRow.findIndex(h => typeof h === 'string' && h.trim().toLowerCase() === 'category');
    if (cIdx >= 0) catIdx = cIdx;
    const iIdx = headRow.findIndex(h => typeof h === 'string' && h.trim().toLowerCase() === 'issn');
    if (iIdx >= 0) issnIdx = iIdx;
    const eiIdx = headRow.findIndex(h => typeof h === 'string' && h.trim().toLowerCase() === 'eissn');
    if (eiIdx >= 0) eissnIdx = eiIdx;
    const jIdx = headRow.findIndex(h => typeof h === 'string' && h.trim().toLowerCase().includes('rank'));
    if (jIdx >= 0) jifRankIdx = jIdx;
  }
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 1) continue;
    
    const catStr = row[catIdx] as string;
    const jifRankStr = row[jifRankIdx] as string;
    
    const issnStr = row[issnIdx] ? String(row[issnIdx]) : '';
    const eissnStr = row[eissnIdx] ? String(row[eissnIdx]) : '';
    const issn = issnStr.replace(/-/g, '').toUpperCase();
    const eissn = eissnStr.replace(/-/g, '').toUpperCase();
    
    let bestPercentile = 100;
    let bestCategoryTitle = '';
    
    const catGroups = catStr && typeof catStr === 'string' ? catStr.split(';') : [];
    const rankGroups = jifRankStr && typeof jifRankStr === 'string' ? jifRankStr.split(';') : [];
    
    for (let cIdx = 0; cIdx < catGroups.length; cIdx++) {
      const gStr = catGroups[cIdx].trim();
      if (!gStr) continue;
      
      const parts = gStr.split('|');
      const cTitle = parts.length > 0 ? parts[0].trim() : gStr.trim();
      let p = 100;
      
      // Try to parse from JIF Rank column first
      if (cIdx < rankGroups.length) {
        const rg = rankGroups[cIdx].trim();
        if (rg && rg.includes('/')) {
           const rp = rg.split('/');
           if (rp.length === 2) {
              const r = parseInt(rp[0].trim(), 10);
              const t = parseInt(rp[1].trim(), 10);
              if (!isNaN(r) && !isNaN(t) && t > 0) {
                 p = (r / t) * 100;
              }
           }
        }
      }
      
      // If p is still 100, try to parse from Category format (third part)
      if (p === 100 && parts.length >= 3) {
        const rp = parts[2].split('/');
        if (rp.length === 2) {
          const r = parseInt(rp[0].trim(), 10);
          const t = parseInt(rp[1].trim(), 10);
          if (!isNaN(r) && !isNaN(t) && t > 0) {
             p = (r / t) * 100;
          }
        }
      }
      
      if (p < bestPercentile) {
        bestPercentile = p;
        bestCategoryTitle = cTitle;
      }
    }
    
    if (bestPercentile === 100 && jifRankStr && typeof jifRankStr === 'string') {
        const rankSplits = jifRankStr.split(';');
        for (const rg of rankSplits) {
          const rgt = rg.trim();
          if (rgt.includes('/')) {
             const rp = rgt.split('/');
             if (rp.length === 2) {
                const r = parseInt(rp[0].trim(), 10);
                const t = parseInt(rp[1].trim(), 10);
                if (!isNaN(r) && !isNaN(t) && t > 0) {
                   const p = (r / t) * 100;
                   if (p < bestPercentile) bestPercentile = p;
                }
             }
          }
        }
    }
    
    if (!bestCategoryTitle && catGroups.length > 0) {
       bestCategoryTitle = catGroups[0].split('|')[0].trim();
    }
    
    const tryBind = (code: string) => {
      if (!code || code === 'N/A') return;
      if (!map[code] || map[code].percentile > bestPercentile) {
        map[code] = { percentile: bestPercentile, category: bestCategoryTitle };
      }
    };
    
    tryBind(issn);
    tryBind(eissn);
  }

  return map;
};

const loadJCRData = async (inputUrl: string) => {
  const url = formatUrlForDownload(inputUrl);
  if (jcrCache && jcrCache.url === url) return jcrCache.data;
  
  let buffer: ArrayBuffer | null = null;
  let lastErrorMessage = '';

  // 1st attempt: Local Express API proxy (avoids CORS)
  try {
    const proxyRes = await fetch("/api/proxy-jcr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (proxyRes.ok) {
      buffer = await proxyRes.arrayBuffer();
    } else {
      let errText = '';
      try {
        const errJson: any = await proxyRes.json();
        errText = errJson?.error || '';
      } catch {
        errText = `HTTP ${proxyRes.status} ${proxyRes.statusText}`;
      }
      lastErrorMessage = errText || `Proxy error: HTTP ${proxyRes.status}`;
    }
  } catch (proxyError: any) {
    lastErrorMessage = proxyError?.message || 'Proxy server unavailable';
  }

  // 2nd attempt: Direct client-side fetch if proxy failed
  if (!buffer) {
    try {
      const directRes = await fetch(url);
      if (directRes.ok) {
        buffer = await directRes.arrayBuffer();
      } else {
        lastErrorMessage = `URL returned HTTP ${directRes.status} (${directRes.statusText || 'Not Found'})`;
      }
    } catch (directError: any) {
      // 3rd attempt: CORS proxy fallback
      try {
        const corsProxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const corsRes = await fetch(corsProxyUrl, { signal: AbortSignal.timeout(8000) });
        if (corsRes.ok) {
          buffer = await corsRes.arrayBuffer();
        } else {
          lastErrorMessage = `Remote URL not found or inaccessible (HTTP ${corsRes.status})`;
        }
      } catch {
        lastErrorMessage = lastErrorMessage || 'Unable to connect to the provided URL (CORS or network error).';
      }
    }
  }

  if (!buffer) {
    throw new Error(lastErrorMessage || 'Failed to download the JCR Excel file. Please verify the URL or upload the file directly.');
  }

  const map = parseJCRWorkbook(buffer);
  jcrCache = { url, data: map };
  return map;
};


const fetchJournalPercentiles = async (papers: PaperInfo[], jcrUrl: string): Promise<PaperInfo[]> => {
  try {
    let map = jcrCache?.data || null;
    if (!map && jcrUrl && jcrUrl.trim()) {
      try {
        map = await loadJCRData(jcrUrl);
      } catch (loadErr: any) {
        console.warn("JCR data could not be loaded from URL, skipping percentile matching:", loadErr?.message || loadErr);
        return papers;
      }
    }
    if (!map) return papers;
    return papers.map(p => {
      let bestPercentile = 100;
      let bestCategory = '';
      let found = false;
      
      if (p.issns) {
        for (const issn of p.issns) {
          const clean = issn.replace(/-/g, '').toUpperCase();
          if (map[clean] && map[clean].percentile < bestPercentile) {
            bestPercentile = map[clean].percentile;
            bestCategory = map[clean].category;
            found = true;
          }
        }
      }
      
      if (found) {
        return { 
          ...p, 
          topPercentile: bestPercentile,
          topSubjectArea: bestCategory
        };
      }
      return p;
    });
  } catch (err) {
    console.warn("Failed to load JCR data:", err);
    return papers;
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'crossref' | 'scopus' | 'settings'>('scopus');
  
  // Crossref State
  const [inputText, setInputText] = useState('');
  
  // Scopus State
  const [fundingNumber, setFundingNumber] = useState(() => localStorage.getItem('savedFundingNumber') || '');
  const [authorId, setAuthorId] = useState(() => localStorage.getItem('savedAuthorId') || '');
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');

  // Settings State
  const [jcrUrl, setJcrUrl] = useState(() => localStorage.getItem('savedJcrUrl') || '');
  const [jcrUrlStatus, setJcrUrlStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
  const [jcrUrlMessage, setJcrUrlMessage] = useState('');
  const [loadedJournalCount, setLoadedJournalCount] = useState<number>(() => {
    return jcrCache ? Object.keys(jcrCache.data).length : 0;
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const testJcrUrl = async () => {
    if (!jcrUrl) return;
    setJcrUrlStatus('checking');
    setJcrUrlMessage('');
    try {
      const map = await loadJCRData(jcrUrl);
      const count = Object.keys(map).length;
      if (count > 0) {
        setLoadedJournalCount(count);
        setJcrUrlStatus('success');
        setJcrUrlMessage(`성공적으로 ${count.toLocaleString()}개 저널 정보를 로드했습니다.`);
      } else {
        setJcrUrlStatus('error');
        setJcrUrlMessage('파일은 읽었으나 유효한 저널(ISSN) 데이터를 찾지 못했습니다.');
      }
    } catch (err: any) {
      setJcrUrlStatus('error');
      setJcrUrlMessage(err.message || 'JCR 데이터를 로드하지 못했습니다.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setJcrUrlStatus('checking');
    setJcrUrlMessage(`${file.name} 분석 중...`);
    try {
      const buffer = await file.arrayBuffer();
      const map = parseJCRWorkbook(buffer);
      const count = Object.keys(map).length;
      if (count > 0) {
        jcrCache = { url: `local-file:${file.name}`, data: map };
        setLoadedJournalCount(count);
        setJcrUrlStatus('success');
        setJcrUrlMessage(`로컬 파일(${file.name})에서 ${count.toLocaleString()}개 저널을 로드했습니다.`);
      } else {
        setJcrUrlStatus('error');
        setJcrUrlMessage('엑셀 파일에서 Category/ISSN 열 데이터를 찾지 못했습니다.');
      }
    } catch (err: any) {
      setJcrUrlStatus('error');
      setJcrUrlMessage(`파일 분석 실패: ${err.message || err}`);
    }
    // reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  // Shared State
  const [results, setResults] = useState<PaperInfo[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const processCrossrefList = async () => {
    const lines = inputText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length === 0) return;

    setIsProcessing(true);
    setProgress({ current: 0, total: lines.length });
    
    const initialResults: PaperInfo[] = lines.map(line => ({
      id: line,
      type: isDOI(line) ? 'doi' : 'title',
      title: '',
      authors: '',
      date: '',
      journal: '',
      doi: '',
      status: 'pending'
    }));

    setResults(initialResults);
    const updatedResults = [...initialResults];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const type = isDOI(line) ? 'doi' : 'title';
      
      try {
        let url = '';
        if (type === 'doi') {
          url = `https://api.crossref.org/works/${encodeURIComponent(line)}`;
        } else {
          url = `https://api.crossref.org/works?query.title=${encodeURIComponent(line)}&select=DOI,title,author,issued,container-title,publisher&rows=1`;
        }

        const response = await fetch(url);
        
        if (!response.ok) {
          if (response.status === 404) {
             updatedResults[i] = { ...updatedResults[i], status: 'not_found' };
          } else {
             updatedResults[i] = { ...updatedResults[i], status: 'error', errorMsg: `HTTP ${response.status}` };
          }
        } else {
          const data: any = await response.json();
          let item;
          
          if (type === 'doi') {
            item = data?.message;
          } else {
            if (!data?.message?.items || data.message.items.length === 0) {
              updatedResults[i] = { ...updatedResults[i], status: 'not_found' };
              item = null;
            } else {
              item = data.message.items[0];
            }
          }

          if (item) {
            const rawTitle = item.title?.[0] || 'Unknown Title';
            const rawAuthors = item.author?.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()).join(', ') || 'Unknown Authors';
            
            let date = 'Unknown Date';
            if (item.issued?.['date-parts']?.[0]) {
              const parts = item.issued['date-parts'][0];
              date = parts.map((p: number) => p.toString().padStart(2, '0')).join('-');
            }

            const rawJournal = item['container-title']?.[0] || item.publisher || 'Unknown Journal/Publisher';
            const doi = item.DOI || '';

            updatedResults[i] = {
              ...updatedResults[i],
              title: cleanText(rawTitle),
              authors: cleanText(rawAuthors),
              date,
              journal: cleanText(rawJournal),
              doi,
              status: 'success',
              issns: item.ISSN || []
            };
          }
        }
      } catch (error: any) {
        updatedResults[i] = { ...updatedResults[i], status: 'error', errorMsg: error.message };
      }

      setResults([...updatedResults]);
      setProgress({ current: i + 1, total: lines.length });
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (updatedResults.length > 0 && jcrUrl) {
      const finalResults = await fetchJournalPercentiles(updatedResults, jcrUrl);
      setResults(finalResults);
    }

    setIsProcessing(false);
  };

  const deduplicatePapers = (papers: (PaperInfo & { _needsAuthors?: boolean })[]): (PaperInfo & { _needsAuthors?: boolean })[] => {
    const seenDois = new Set<string>();
    const seenScopusIds = new Set<string>();
    const seenTitles = new Set<string>();
    const seenOther = new Set<string>();
    const deduplicated: (PaperInfo & { _needsAuthors?: boolean })[] = [];

    for (const paper of papers) {
      if (paper.status === 'not_found' || paper.status === 'error') {
        const errKey = `${paper.status}:${paper.id}`;
        if (!seenOther.has(errKey)) {
          seenOther.add(errKey);
          deduplicated.push(paper);
        }
        continue;
      }

      const cleanDoi = paper.doi ? paper.doi.trim().toLowerCase() : '';
      const scopusId = paper.id && paper.id.startsWith('SCOPUS_ID:') ? paper.id.trim() : '';
      const normTitle = paper.title && paper.title !== 'Unknown Title' 
        ? paper.title.toLowerCase().replace(/[^a-z0-9가-힣]/g, '') 
        : '';

      let isDuplicate = false;
      let existingIndex = -1;

      if (cleanDoi && seenDois.has(cleanDoi)) {
        isDuplicate = true;
        existingIndex = deduplicated.findIndex(p => p.doi && p.doi.trim().toLowerCase() === cleanDoi);
      } else if (scopusId && seenScopusIds.has(scopusId)) {
        isDuplicate = true;
        existingIndex = deduplicated.findIndex(p => p.id && p.id.trim() === scopusId);
      } else if (normTitle.length >= 8 && seenTitles.has(normTitle)) {
        isDuplicate = true;
        existingIndex = deduplicated.findIndex(p => {
          const otherNorm = p.title ? p.title.toLowerCase().replace(/[^a-z0-9가-힣]/g, '') : '';
          return otherNorm.length >= 8 && otherNorm === normTitle;
        });
      } else if (!cleanDoi && !scopusId && normTitle.length < 8) {
        const fallbackKey = `${paper.id}:${paper.title}`;
        if (seenOther.has(fallbackKey)) {
          isDuplicate = true;
        } else {
          seenOther.add(fallbackKey);
        }
      }

      if (isDuplicate) {
        if (existingIndex !== -1) {
          const existing = deduplicated[existingIndex];
          if (existing._needsAuthors && !paper._needsAuthors && paper.authors) {
            existing.authors = paper.authors;
            existing._needsAuthors = false;
          }
        }
      } else {
        if (cleanDoi) seenDois.add(cleanDoi);
        if (scopusId) seenScopusIds.add(scopusId);
        if (normTitle.length >= 8) seenTitles.add(normTitle);
        deduplicated.push(paper);
      }
    }

    return deduplicated;
  };

  const searchScopus = async () => {
    if (!fundingNumber.trim() && !authorId.trim()) return;

    localStorage.setItem('savedFundingNumber', fundingNumber.trim());
    localStorage.setItem('savedAuthorId', authorId.trim());

    const fNums = fundingNumber.split(/[\n,]+/).map(n => n.trim());
    const aIds = authorId.split(/[\n,]+/).map(n => n.trim());
    
    // Clean up empty items at the end
    while(fNums.length > 0 && !fNums[fNums.length - 1]) fNums.pop();
    while(aIds.length > 0 && !aIds[aIds.length - 1]) aIds.pop();

    const maxLen = Math.max(fNums.length, aIds.length);
    if (maxLen === 0) return;

    setIsProcessing(true);
    setResults([]);
    setProgress({ current: 0, total: maxLen });
    
    let combinedResults: (PaperInfo & { _needsAuthors?: boolean })[] = [];

    for (let i = 0; i < maxLen; i++) {
      const fNum = fNums[i] || '';
      const aId = aIds[i] || '';
      
      if (!fNum && !aId) continue;
      
      const displayId = [fNum, aId].filter(Boolean).join(' | ');
      
      let queryParts = [];
      if (fNum) queryParts.push(`FUND-NO(${fNum})`);
      if (aId) queryParts.push(`AU-ID(${aId})`);
      
      let queryStr = queryParts.length > 1 ? `(${queryParts.join(' OR ')})` : queryParts[0];

      if (startMonth.trim() || endMonth.trim()) {
        const sYear = startMonth ? startMonth.split('-')[0] : '1950';
        // Use 2050 as default end year
        const eYear = endMonth ? endMonth.split('-')[0] : '2050';
        // Scopus &date=YYYY-YYYY is currently returning 500 Internal Server Errors on Elsevier's side, 
        // so we use PUBYEAR in the query string instead as a robust workaround.
        queryStr += ` AND PUBYEAR > ${parseInt(sYear, 10) - 1} AND PUBYEAR < ${parseInt(eYear, 10) + 1}`;
      }
      const query = encodeURIComponent(queryStr);
      
      try {
        let allEntries: any[] = [];
        let start = 0;
        const count = 25;
        let totalResults = 1;
        let isFirst = true;
        let useCompleteView = true;

        while (start < totalResults) {
          let url = `/api/scopus?query=${query}&count=${count}&start=${start}${useCompleteView ? '&view=COMPLETE' : ''}`;
          
          let response = await fetch(url, {
            headers: {
              'Accept': 'application/json'
            }
          });

          // If view=COMPLETE fails, fallback to standard view
          if (!response.ok && useCompleteView) {
            useCompleteView = false;
            url = `/api/scopus?query=${query}&count=${count}&start=${start}`;
            response = await fetch(url, {
              headers: {
                'Accept': 'application/json'
              }
            });
          }

          if (!response.ok) {
            let errorDetail = response.statusText;
            try {
              const errJson: any = await response.json();
              errorDetail = errJson?.error || errJson?.['service-error']?.status?.statusText || JSON.stringify(errJson);
            } catch (e) {
              // Ignore JSON parse error
            }
            throw new Error(`HTTP ${response.status}: ${errorDetail}`);
          }

          const data: any = await response.json();
          
          if (isFirst) {
            totalResults = parseInt(data['search-results']?.['opensearch:totalResults'] || '0', 10);
            if (totalResults > 500) totalResults = 500;
            isFirst = false;
          }

          const entries = data['search-results']?.entry || [];
          if (entries.length === 0) break;
          
          allEntries = [...allEntries, ...entries];
          start += count;
          
          if (start < totalResults) {
            await new Promise(resolve => setTimeout(resolve, 200)); // Rate limiting pause
          }
        }
        
        // Local filtering for exact YYYY-MM range
        let filteredEntries = allEntries;
        if (startMonth || endMonth) {
          const sMonthStr = startMonth || "1900-01";
          const eMonthStr = endMonth || "2999-12";
          filteredEntries = allEntries.filter(entry => {
            const coverDate = entry['prism:coverDate']; // e.g. "2021-08-01"
            if (!coverDate) return true;
            const entryMonthStr = coverDate.substring(0, 7); // "YYYY-MM"
            return entryMonthStr >= sMonthStr && entryMonthStr <= eMonthStr;
          });
        }

        if (filteredEntries.length === 0) {
          combinedResults.push({
            id: displayId,
            type: 'funding',
            title: `No results found for ${displayId}`,
            authors: '',
            date: '',
            journal: '',
            doi: '',
            status: 'not_found'
          });
        } else {
          const newResults: (PaperInfo & { _needsAuthors?: boolean })[] = filteredEntries.map((entry: any) => {
            let rawAuthors = entry['dc:creator'] || 'Unknown Authors';
            let hasFullAuthors = false;
            
            if (entry.author && Array.isArray(entry.author)) {
              rawAuthors = entry.author.map((a: any) => {
                if (a.authname) return a.authname;
                if (a['given-name'] && a.surname) return `${a['given-name']} ${a.surname}`;
                if (a.surname) return a.surname;
                return '';
              }).filter(Boolean).join(', ');
              hasFullAuthors = true;
            }

            return {
              id: entry['dc:identifier'] || displayId,
              type: 'funding',
              title: cleanText(entry['dc:title'] || 'Unknown Title'),
              authors: cleanText(rawAuthors),
              date: entry['prism:coverDate'] || 'Unknown Date',
              journal: cleanText(entry['prism:publicationName'] || 'Unknown Journal'),
              doi: entry['prism:doi'] || '',
              status: 'success',
              issns: [entry['prism:issn'], entry['prism:eIssn']].filter(Boolean) as string[],
              _needsAuthors: !hasFullAuthors && !!entry['prism:doi']
            };
          });
          
          combinedResults = [...combinedResults, ...newResults];
        }
        
        combinedResults = deduplicatePapers(combinedResults);
        setResults([...combinedResults]);
        setProgress({ current: i + 1, total: maxLen });

      } catch (error: any) {
        combinedResults.push({
          id: displayId,
          type: 'funding',
          title: `Search failed`,
          authors: '',
          date: '',
          journal: '',
          doi: '',
          status: 'error',
          errorMsg: error.message
        });
        combinedResults = deduplicatePapers(combinedResults);
        setResults([...combinedResults]);
        setProgress({ current: i + 1, total: maxLen });
      }
    }

    // Phase 3: Fetch missing authors from Crossref using DOI
    const needsAuthorsCount = combinedResults.filter(r => r._needsAuthors).length;
    if (needsAuthorsCount > 0) {
      let fetchedCount = 0;
      for (let i = 0; i < combinedResults.length; i++) {
        if (combinedResults[i]._needsAuthors) {
          try {
            const crRes = await fetch(`https://api.crossref.org/works/${encodeURIComponent(combinedResults[i].doi)}`);
            if (crRes.ok) {
              const crData: any = await crRes.json();
              if (crData?.message?.author) {
                const fullAuthors = crData.message.author.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()).join(', ');
                if (fullAuthors) {
                  combinedResults[i].authors = cleanText(fullAuthors);
                }
              }
            }
          } catch (e) {
            // Ignore crossref errors and keep the single author
          }
          fetchedCount++;
          setResults([...combinedResults]);
          await new Promise(resolve => setTimeout(resolve, 100)); // Be polite to Crossref API
        }
      }
    }

    // Phase 4: Fetch Journal Percentiles
    if (combinedResults.length > 0 && jcrUrl) {
      combinedResults = await fetchJournalPercentiles(combinedResults, jcrUrl);
      setResults([...combinedResults]);
    }

    setIsProcessing(false);
  };

  const exportCSV = useCallback(() => {
    if (results.length === 0) return;

    const headers = ['Input/ID', 'Type', 'Title', 'Authors', 'Publication Date', 'Journal/Publisher', 'Top %', 'DOI', 'Status'];
    const csvContent = [
      headers.join(','),
      ...results.map(r => [
        `"${r.id.replace(/"/g, '""')}"`,
        r.type,
        `"${r.title.replace(/"/g, '""')}"`,
        `"${r.authors.replace(/"/g, '""')}"`,
        `"${r.date}"`,
        `"${r.journal.replace(/"/g, '""')}"`,
        r.topPercentile ? `"${r.topPercentile.toFixed(2)}% (${r.topSubjectArea || ''})"` : '""',
        `"${r.doi}"`,
        r.status
      ].join(','))
    ].join('\n');

    // Add UTF-8 BOM (\uFEFF) so Excel opens it with correct encoding automatically
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'paper_metadata.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [results]);

  const clearAll = () => {
    setInputText('');
    setFundingNumber('');
    setAuthorId('');
    setStartMonth('');
    setEndMonth('');
    setResults([]);
    setProgress({ current: 0, total: 0 });
  };

  return (
    <div className="min-h-screen bg-[#f5f5f5] font-sans text-gray-900 p-6 md:p-12">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="space-y-4">
          <h1 className="text-3xl font-light tracking-tight flex items-center gap-3">
            <FileText className="w-8 h-8 text-blue-600" />
            Paper Metadata Extractor
          </h1>
          <p className="text-gray-500 text-sm md:text-base max-w-2xl">
            Extract publication dates, authors, journals, and DOIs using Crossref (by DOI/Title) or Scopus (by Funding Number / Author ID).
          </p>
          
          {/* Tabs */}
          <div className="flex gap-2 border-b border-gray-200 pb-px">
            <button
              onClick={() => setActiveTab('scopus')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'scopus' 
                  ? 'border-blue-600 text-blue-600' 
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Scopus (Funding / Author)
            </button>
            <button
              onClick={() => setActiveTab('crossref')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'crossref' 
                  ? 'border-blue-600 text-blue-600' 
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Crossref (DOI / Title)
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'settings' 
                  ? 'border-blue-600 text-blue-600' 
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Settings
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Input Section */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col min-h-[600px]">
              
              {activeTab === 'settings' ? (
                <div className="flex flex-col gap-6 h-full">
                  <div>
                    <label className="text-sm font-medium text-gray-700 uppercase tracking-wider mb-2 flex items-center gap-2">
                      <Link className="w-4 h-4 text-blue-600" />
                      JCR Excel URL
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={jcrUrl}
                        onChange={(e) => {
                          setJcrUrl(e.target.value);
                          localStorage.setItem('savedJcrUrl', e.target.value);
                          setJcrUrlStatus('idle');
                          setJcrUrlMessage('');
                        }}
                        placeholder="https://.../JCR_IMPACTFACTORS.xlsx 또는 Google Drive 링크"
                        className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                      />
                      <button
                        onClick={testJcrUrl}
                        disabled={jcrUrlStatus === 'checking'}
                        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap flex items-center gap-1.5"
                      >
                        {jcrUrlStatus === 'checking' ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            확인 중...
                          </>
                        ) : (
                          'Verify URL'
                        )}
                      </button>
                    </div>

                    <p className="text-xs text-gray-500 mt-2">
                      Google Drive 공유 링크, 웹 서버 직링크(URL)를 입력하시면 상위 저널 백분위(Top %)를 자동 계산합니다.
                    </p>
                  </div>

                  <div className="pt-2 border-t border-gray-100">
                    <label className="text-sm font-medium text-gray-700 uppercase tracking-wider mb-2 flex items-center gap-2">
                      <Upload className="w-4 h-4 text-emerald-600" />
                      또는 엑셀 파일 직접 업로드 (.xlsx)
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx, .xls"
                      onChange={handleFileUpload}
                      className="hidden"
                      id="jcr-file-input"
                    />
                    <label
                      htmlFor="jcr-file-input"
                      className="flex items-center justify-center gap-2 w-full border-2 border-dashed border-gray-200 hover:border-blue-400 hover:bg-blue-50/30 rounded-xl p-4 text-sm text-gray-600 font-medium cursor-pointer transition-all"
                    >
                      <Upload className="w-4 h-4 text-gray-500" />
                      내 컴퓨터에서 JCR 엑셀 파일 선택
                    </label>
                    <p className="text-xs text-gray-400 mt-1.5">
                      URL 다운로드가 원격 서버에서 차단/삭제된 경우 직접 파일을 업로드해 즉시 사용할 수 있습니다.
                    </p>
                  </div>

                  {jcrUrlMessage && (
                    <div className={`p-3.5 rounded-xl flex items-start gap-2.5 text-sm ${
                      jcrUrlStatus === 'success' ? 'bg-green-50 text-green-800 border border-green-100' : 'bg-red-50 text-red-800 border border-red-100'
                    }`}>
                      {jcrUrlStatus === 'success' ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />
                      ) : (
                        <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />
                      )}
                      <div className="flex-1 text-xs md:text-sm whitespace-pre-wrap">{jcrUrlMessage}</div>
                    </div>
                  )}

                  {loadedJournalCount > 0 && (
                    <div className="p-3 bg-blue-50 rounded-xl text-xs text-blue-700 flex items-center justify-between">
                      <span>현재 로드된 저널 수:</span>
                      <span className="font-semibold">{loadedJournalCount.toLocaleString()}개</span>
                    </div>
                  )}

                  <div className="text-xs text-gray-500 space-y-1 bg-gray-50 p-3.5 rounded-xl border border-gray-100">
                    <p className="font-medium text-gray-700">필수 열(Column) 구성 안내:</p>
                    <p>• 엑셀 파일 내에 'Category', 'ISSN', 'eISSN' 및 'JIF Rank' 열이 포함되어 있어야 합니다.</p>
                  </div>
                </div>
              ) : activeTab === 'crossref' ? (
                <>
                  <div className="flex justify-between items-center mb-3">
                    <label htmlFor="input-list" className="text-sm font-medium text-gray-700 uppercase tracking-wider">
                      Input List
                    </label>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
                      {inputText.split('\n').filter(l => l.trim()).length} items
                    </span>
                  </div>
                  <textarea
                    id="input-list"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="10.1038/s41586-020-2649-2&#10;Attention Is All You Need&#10;10.1126/science.1246390"
                    className="flex-1 w-full resize-none rounded-xl border border-gray-200 p-4 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                    disabled={isProcessing}
                  />
                  <div className="mt-4 flex gap-3">
                    <button
                      onClick={processCrossrefList}
                      disabled={isProcessing || !inputText.trim()}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <Search className="w-4 h-4" />
                          Extract Info
                        </>
                      )}
                    </button>
                    <button
                      onClick={clearAll}
                      disabled={isProcessing || (!inputText && results.length === 0)}
                      className="bg-gray-100 hover:bg-gray-200 text-gray-700 p-2.5 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Clear All"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-4 h-full">
                    <div className="flex-1">
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-sm font-medium text-gray-700 uppercase tracking-wider block">
                          Funding Number(s)
                        </label>
                        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
                          {fundingNumber.split(/[\n,]+/).filter(l => l.trim()).length} items
                        </span>
                      </div>
                      <textarea
                        value={fundingNumber}
                        onChange={(e) => setFundingNumber(e.target.value)}
                        placeholder="e.g., NRF-2021R1A2C1000000"
                        className="w-full resize-none h-[110px] rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        disabled={isProcessing}
                      />
                    </div>

                    <div className="flex-1">
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-sm font-medium text-gray-700 uppercase tracking-wider block">
                          Author ID(s)
                        </label>
                        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
                          {authorId.split(/[\n,]+/).filter(l => l.trim()).length} items
                        </span>
                      </div>
                      <textarea
                        value={authorId}
                        onChange={(e) => setAuthorId(e.target.value)}
                        placeholder="e.g., 57209617104"
                        className="w-full resize-none h-[110px] rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        disabled={isProcessing}
                      />
                    </div>

                    <div className="flex gap-4">
                      <div className="flex-1">
                        <label className="text-sm font-medium text-gray-700 uppercase tracking-wider mb-2 block">
                          Start Month (Opt)
                        </label>
                        <input
                          type="month"
                          value={startMonth}
                          onChange={(e) => setStartMonth(e.target.value)}
                          className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                          disabled={isProcessing}
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-sm font-medium text-gray-700 uppercase tracking-wider mb-2 block">
                          End Month (Opt)
                        </label>
                        <input
                          type="month"
                          value={endMonth}
                          onChange={(e) => setEndMonth(e.target.value)}
                          className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                          disabled={isProcessing}
                        />
                      </div>
                    </div>

                    <div className="mt-auto flex gap-3">
                      <button
                        onClick={searchScopus}
                        disabled={isProcessing || (!fundingNumber.trim() && !authorId.trim())}
                        className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        {isProcessing ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Searching...
                          </>
                        ) : (
                          <>
                            <Search className="w-4 h-4" />
                            Search Scopus
                          </>
                        )}
                      </button>
                      <button
                        onClick={clearAll}
                        disabled={isProcessing || (!fundingNumber && !authorId && results.length === 0)}
                        className="bg-gray-100 hover:bg-gray-200 text-gray-700 p-2.5 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Clear All"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Results Section */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 h-[500px] flex flex-col">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-4">
                  <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wider">
                    Results
                  </h2>
                  {activeTab === 'scopus' || activeTab === 'crossref' ? (
                    <>
                      {isProcessing && activeTab === 'crossref' && (
                        <div className="text-xs text-blue-600 font-medium bg-blue-50 px-3 py-1 rounded-full flex items-center gap-2">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          {progress.current} / {progress.total}
                        </div>
                      )}
                      {results.length > 0 && activeTab === 'scopus' && !isProcessing && (
                        <div className="text-xs text-green-600 font-medium bg-green-50 px-3 py-1 rounded-full">
                          Found {results.length} papers (중복 제외)
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
                {activeTab === 'scopus' || activeTab === 'crossref' ? (
                  <button
                    onClick={exportCSV}
                    disabled={results.length === 0 || isProcessing}
                    className="text-sm font-medium text-gray-600 hover:text-blue-600 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4" />
                    Export CSV
                  </button>
                ) : null}
              </div>

              <div className="flex-1 overflow-auto border border-gray-100 rounded-xl">
                {activeTab === 'settings' ? (
                   <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3">
                      <Settings className="w-12 h-12 opacity-20" />
                      <p className="text-sm">Configure your settings in the left panel.</p>
                   </div>
                ) : results.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3">
                    <FileText className="w-12 h-12 opacity-20" />
                    <p className="text-sm">
                      {activeTab === 'crossref' 
                        ? 'Enter DOIs or titles and click Extract to see results.'
                        : 'Enter Funding Number or Author ID to search Scopus.'}
                    </p>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-sm">
                    <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="p-3 font-medium text-gray-500 border-b border-gray-200">Status</th>
                        <th className="p-3 font-medium text-gray-500 border-b border-gray-200">Title</th>
                        <th className="p-3 font-medium text-gray-500 border-b border-gray-200">Authors</th>
                        <th className="p-3 font-medium text-gray-500 border-b border-gray-200">Date</th>
                        <th className="p-3 font-medium text-gray-500 border-b border-gray-200">Journal</th>
                        <th className="p-3 font-medium text-gray-500 border-b border-gray-200">Top %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {results.map((result, idx) => (
                        <tr key={idx} className="hover:bg-gray-50 transition-colors">
                          <td className="p-3 whitespace-nowrap">
                            {result.status === 'pending' && <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />}
                            {result.status === 'success' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                            {result.status === 'not_found' && <AlertCircle className="w-5 h-5 text-amber-500" title="Not Found" />}
                            {result.status === 'error' && <XCircle className="w-5 h-5 text-red-500" title={result.errorMsg} />}
                          </td>
                          <td className="p-3 max-w-[200px] truncate" title={result.title || result.id}>
                            <div className="font-medium text-gray-900 truncate">{result.title || result.id}</div>
                            {result.doi && <div className="text-xs text-gray-400 font-mono mt-0.5">{result.doi}</div>}
                          </td>
                          <td className="p-3 max-w-[150px] truncate text-gray-600" title={result.authors}>
                            {result.authors}
                          </td>
                          <td className="p-3 whitespace-nowrap text-gray-600 font-mono text-xs">
                            {result.date}
                          </td>
                          <td className="p-3 max-w-[150px] truncate text-gray-600" title={result.journal}>
                            {result.journal}
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {result.topPercentile ? (
                              <span 
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 cursor-help"
                                title={result.topSubjectArea}
                              >
                                Top {result.topPercentile.toFixed(2)}%
                              </span>
                            ) : (
                              <span className="text-gray-300">-</span>
                            )}
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

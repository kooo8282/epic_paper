import React, { useState, useCallback } from 'react';
import { Search, Download, Trash2, FileText, CheckCircle2, XCircle, Loader2, AlertCircle, Key } from 'lucide-react';

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

export default function App() {
  const [activeTab, setActiveTab] = useState<'crossref' | 'scopus'>('scopus');
  
  // Crossref State
  const [inputText, setInputText] = useState('');
  
  // Scopus State
  const [scopusApiKey, setScopusApiKey] = useState('a3506e81fdc320fdee24ea389b06ca33');
  const [fundingNumber, setFundingNumber] = useState(() => localStorage.getItem('savedFundingNumber') || '');
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');
  
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
          const data = await response.json();
          let item;
          
          if (type === 'doi') {
            item = data.message;
          } else {
            if (data.message.items.length === 0) {
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
              status: 'success'
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

    setIsProcessing(false);
  };

  const searchScopus = async () => {
    if (!scopusApiKey.trim() || !fundingNumber.trim()) return;

    localStorage.setItem('savedFundingNumber', fundingNumber.trim());

    const fNums = fundingNumber.split(/[\n,]+/).map(n => n.trim()).filter(Boolean);
    if (fNums.length === 0) return;

    setIsProcessing(true);
    setResults([]);
    setProgress({ current: 0, total: fNums.length });

    let dateParam = '';
    if (startMonth.trim() || endMonth.trim()) {
      const sYear = startMonth ? startMonth.split('-')[0] : '1950';
      // Use 2050 as default end year to ensure we catch all future papers and avoid negative ranges
      const eYear = endMonth ? endMonth.split('-')[0] : '2050';
      dateParam = `&date=${sYear}-${eYear}`;
    }
    
    let combinedResults: (PaperInfo & { _needsAuthors?: boolean })[] = [];

    for (let i = 0; i < fNums.length; i++) {
      const fNum = fNums[i];
      const query = `FUND-NO(${encodeURIComponent(fNum)})`;
      
      try {
        let allEntries: any[] = [];
        let start = 0;
        const count = 25;
        let totalResults = 1;
        let isFirst = true;
        let useCompleteView = true;

        while (start < totalResults) {
          let url = `https://api.elsevier.com/content/search/scopus?query=${query}${dateParam}&count=${count}&start=${start}${useCompleteView ? '&view=COMPLETE' : ''}`;
          
          let response = await fetch(url, {
            headers: {
              'X-ELS-APIKey': scopusApiKey.trim(),
              'Accept': 'application/json'
            }
          });

          // If view=COMPLETE fails, fallback to standard view
          if (!response.ok && useCompleteView) {
            useCompleteView = false;
            url = `https://api.elsevier.com/content/search/scopus?query=${query}${dateParam}&count=${count}&start=${start}`;
            response = await fetch(url, {
              headers: {
                'X-ELS-APIKey': scopusApiKey.trim(),
                'Accept': 'application/json'
              }
            });
          }

          if (!response.ok) {
            let errorDetail = response.statusText;
            try {
              const errJson = await response.json();
              errorDetail = errJson['service-error']?.status?.statusText || JSON.stringify(errJson);
            } catch (e) {
              // Ignore JSON parse error
            }
            throw new Error(`HTTP ${response.status}: ${errorDetail}`);
          }

          const data = await response.json();
          
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
            id: fNum,
            type: 'funding',
            title: `No results found for funding number: ${fNum}`,
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
              id: entry['dc:identifier'] || fNum,
              type: 'funding',
              title: cleanText(entry['dc:title'] || 'Unknown Title'),
              authors: cleanText(rawAuthors),
              date: entry['prism:coverDate'] || 'Unknown Date',
              journal: cleanText(entry['prism:publicationName'] || 'Unknown Journal'),
              doi: entry['prism:doi'] || '',
              status: 'success',
              _needsAuthors: !hasFullAuthors && !!entry['prism:doi']
            };
          });
          
          combinedResults = [...combinedResults, ...newResults];
        }
        
        setResults([...combinedResults]);
        setProgress({ current: i + 1, total: fNums.length });

      } catch (error: any) {
        combinedResults.push({
          id: fNum,
          type: 'funding',
          title: `Search failed`,
          authors: '',
          date: '',
          journal: '',
          doi: '',
          status: 'error',
          errorMsg: error.message
        });
        setResults([...combinedResults]);
        setProgress({ current: i + 1, total: fNums.length });
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
              const crData = await crRes.json();
              if (crData.message && crData.message.author) {
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

    setIsProcessing(false);
  };

  const exportCSV = useCallback(() => {
    if (results.length === 0) return;

    const headers = ['Input/ID', 'Type', 'Title', 'Authors', 'Publication Date', 'Journal/Publisher', 'DOI', 'Status'];
    const csvContent = [
      headers.join(','),
      ...results.map(r => [
        `"${r.id.replace(/"/g, '""')}"`,
        r.type,
        `"${r.title.replace(/"/g, '""')}"`,
        `"${r.authors.replace(/"/g, '""')}"`,
        `"${r.date}"`,
        `"${r.journal.replace(/"/g, '""')}"`,
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
            Extract publication dates, authors, journals, and DOIs using Crossref (by DOI/Title) or Scopus (by Funding Number).
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
              Scopus (Funding Number)
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
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Input Section */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col h-[500px]">
              
              {activeTab === 'crossref' ? (
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
                    <div>
                      <label className="text-sm font-medium text-gray-700 uppercase tracking-wider mb-2 block flex items-center gap-2">
                        <Key className="w-4 h-4" />
                        Scopus API Key
                      </label>
                      <input
                        type="password"
                        value={scopusApiKey}
                        onChange={(e) => setScopusApiKey(e.target.value)}
                        placeholder="Enter your Elsevier API Key"
                        className="w-full rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                        disabled={isProcessing}
                      />
                      <p className="text-xs text-gray-500 mt-2">
                        Required to use Scopus API. Get one from the <a href="https://dev.elsevier.com/" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Elsevier Developer Portal</a>.
                      </p>
                    </div>

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
                        placeholder="e.g., NRF-2021R1A2C1000000&#10;2020R1A5A8018822"
                        className="w-full resize-none h-[120px] rounded-xl border border-gray-200 p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
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
                        disabled={isProcessing || !scopusApiKey.trim() || !fundingNumber.trim()}
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
                        disabled={isProcessing || (!fundingNumber && results.length === 0)}
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
                  {isProcessing && activeTab === 'crossref' && (
                    <div className="text-xs text-blue-600 font-medium bg-blue-50 px-3 py-1 rounded-full flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {progress.current} / {progress.total}
                    </div>
                  )}
                  {results.length > 0 && activeTab === 'scopus' && !isProcessing && (
                    <div className="text-xs text-green-600 font-medium bg-green-50 px-3 py-1 rounded-full">
                      Found {results.length} papers
                    </div>
                  )}
                </div>
                <button
                  onClick={exportCSV}
                  disabled={results.length === 0 || isProcessing}
                  className="text-sm font-medium text-gray-600 hover:text-blue-600 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </button>
              </div>

              <div className="flex-1 overflow-auto border border-gray-100 rounded-xl">
                {results.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3">
                    <FileText className="w-12 h-12 opacity-20" />
                    <p className="text-sm">
                      {activeTab === 'crossref' 
                        ? 'Enter DOIs or titles and click Extract to see results.'
                        : 'Enter an API Key and Funding Number to search Scopus.'}
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

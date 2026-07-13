/**
 * FileManager — multi-tab file browser with cross-server drag-and-drop.
 *
 * Tab bar: add (+) / close (×) / switch tabs.
 * Drag a file or folder from the tree → hover a tab label to switch → drop in the
 * destination tree.  Before copying, a duplicate-check modal lets the user
 * Skip / Replace / Rename.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { api, Server } from '../api/client'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type FsEntry     = { name:string; type:'dir'|'file'|'link'|'other'; permissions:string; owner:string; size:number; modified:string }
type LsResult    = { path:string; parent:string; entries:FsEntry[] }
type ReadResult  = { content:string|null; binary:boolean; mime:string; size:number }
type SearchResult= { mode:string; matches:string[]; grep_lines:string[] }
type LintResult  = { supported:boolean; output:string; ok:boolean }
type VersionEntry= { name:string; path:string; size:number; modified:string }

type DragInfo = {
  tabId: string
  serverId: string
  serverName: string
  srcPath: string   // full absolute path on the source server
  entry: FsEntry
}

type DropConfirmState = {
  drag: DragInfo
  destServerId: string
  destServerName: string
  destDir: string
  existingType: 'file' | 'dir'
  proposedName: string
}

type TabMeta = { id: string; label: string; serverId?: string; curPath?: string; openFile?: string }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const LANG_MAP: Record<string,string> = {
  js:'javascript', jsx:'javascript', mjs:'javascript', ts:'typescript', tsx:'typescript',
  php:'php', py:'python', rb:'ruby', go:'go', rs:'rust', java:'java', cs:'csharp',
  sh:'shell', bash:'shell', zsh:'shell', fish:'shell',
  html:'html', htm:'html', xml:'xml', svg:'xml',
  css:'css', scss:'scss', sass:'scss', less:'less',
  json:'json', jsonc:'json', yaml:'yaml', yml:'yaml',
  toml:'ini', ini:'ini', cfg:'ini', conf:'ini', env:'ini',
  md:'markdown', sql:'sql', dockerfile:'dockerfile',
  txt:'plaintext', log:'plaintext', csv:'plaintext',
}
function detectLang(p:string){
  const n=p.split('/').pop()?.toLowerCase()??''
  if(n==='dockerfile'||n.startsWith('dockerfile.'))return 'dockerfile'
  if(n==='.env'||n.startsWith('.env.'))return 'ini'
  if(n==='makefile')return 'makefile'
  return LANG_MAP[n.split('.').pop()??'']??'plaintext'
}
function fmt(b:number){
  if(b<1024)return`${b} B`
  if(b<1048576)return`${(b/1024).toFixed(1)} KB`
  return`${(b/1048576).toFixed(2)} MB`
}
function join(...parts:string[]){ return parts.join('/').replace(/\/+/g,'/')||'/' }
function uid(){ return Math.random().toString(36).slice(2,10) }

// CSS variables defined in index.css — safe in both light + dark themes
const C = {
  text:'var(--text-primary)',   muted:'var(--text-muted)',
  card:'var(--card-bg)',        border:'var(--border-med)',
  bg:'var(--bg-body)',          accent:'var(--accent-hex)',
  success:'var(--success)',     error:'var(--error)',
  warning:'var(--warning)',
  sidebarBg:'var(--sidebar-bg)',
  sidebarTxt:'var(--sidebar-text)',
  sidebarActive:'var(--sidebar-active-bg)',
  sidebarActTxt:'var(--sidebar-active-text)',
  inputBg:'var(--input-bg)',    inputTxt:'var(--input-text)',
  inputBdr:'var(--input-border)',
  cardBdr:'var(--card-border)',
}

function Btn({ onClick,disabled,title,bg,children,full,small }:{
  onClick?:()=>void; disabled?:boolean; title?:string; bg?:string
  children:React.ReactNode; full?:boolean; small?:boolean
}){
  return(
    <button onClick={onClick} disabled={disabled} title={title} style={{
      padding:small?'2px 6px':'3px 8px', fontSize:small?10:11, borderRadius:4,
      border:`1px solid ${C.border}`, background:bg??C.card, color:bg?'#fff':C.text,
      cursor:disabled?'not-allowed':'pointer', opacity:disabled?0.5:1,
      width:full?'100%':undefined, textAlign:'left' as const,
    }}>{children}</button>
  )
}

function IInput({ value,onChange,onKeyDown,placeholder,autoFocus }:{
  value:string; onChange:(v:string)=>void; onKeyDown?:(e:React.KeyboardEvent)=>void
  placeholder?:string; autoFocus?:boolean
}){
  return(
    <input autoFocus={autoFocus} value={value} onChange={e=>onChange(e.target.value)}
      onKeyDown={onKeyDown} placeholder={placeholder}
      style={{ flex:1, padding:'3px 6px', borderRadius:4, border:`1px solid ${C.inputBdr}`,
        background:C.inputBg, color:C.inputTxt, fontSize:12 }} />
  )
}

function EntryIcon({ e }:{ e:FsEntry }){
  if(e.type==='dir') return <span style={{color:'#58a6ff'}}>📁</span>
  if(e.type==='link')return <span style={{color:'#bc8cff'}}>🔗</span>
  const x=e.name.split('.').pop()?.toLowerCase()??''
  const col=['js','jsx','ts','tsx'].includes(x)?'#f1e05a':['php'].includes(x)?'#4f5d95':
    ['py'].includes(x)?'#3572A5':['sh','bash','zsh'].includes(x)?'#89e051':
    ['json','yaml','yml','toml'].includes(x)?'#f97316':['html','htm'].includes(x)?'#e34c26':
    ['css','scss'].includes(x)?'#563d7c':['sql'].includes(x)?'#e38c00':C.muted
  return <span style={{color:col}}>📄</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// FileManagerTab — single-tab component
// ─────────────────────────────────────────────────────────────────────────────
interface TabProps {
  tabId: string
  isActive: boolean
  servers: Server[]
  initServerId: string
  initCurPath: string
  initOpenFile: string | null
  onStateChange: (serverId: string, curPath: string, openFile: string | null) => void
  // Drag-and-drop integration
  onDragStart: (info: DragInfo) => void
  dragInfo: DragInfo | null
  onDropped: (destServerId:string, destDir:string, destEntry:FsEntry|null) => void
  // External copy trigger
  pendingCopy: { drag:DragInfo; destDir:string; destName?:string } | null
  onCopyDone: () => void
}

function FileManagerTab({ tabId, isActive, servers, initServerId, initCurPath, initOpenFile, onStateChange, onDragStart, dragInfo, onDropped, pendingCopy, onCopyDone }: TabProps){
  const [serverId,   setServerId]   = useState(initServerId)
  const [curPath,    setCurPath]    = useState(initCurPath)
  const [openFile,   setOpenFile]   = useState<string|null>(initOpenFile)
  const [entries,    setEntries]    = useState<FsEntry[]>([])
  const [lsLoading,  setLsLoading]  = useState(false)
  const [lsError,    setLsError]    = useState('')

  const [content,      setContent]      = useState('')
  // editorInitValue only changes on file open/restore — keeps Monaco's setValue() from firing
  // during normal edits or diff close, which would wipe the undo stack
  const [editorInitValue, setEditorInitValue] = useState('')
  const [fileMeta,    setFileMeta]    = useState<{mime:string;size:number}|null>(null)
  const [isBinary,    setIsBinary]    = useState(false)
  const [readLoading, setReadLoading] = useState(false)
  const [readError,   setReadError]   = useState('')
  const [isDirty,     setIsDirty]     = useState(false)
  const [savedContent,setSavedContent]= useState('')
  const [showDiff,    setShowDiff]    = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [saveMsg,     setSaveMsg]     = useState('')
  const [archiveOnSave,setArchiveOnSave] = useState(true)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor|null>(null)
  const [cursor,  setCursor]  = useState({line:1,col:1})

  const [lintResult,  setLintResult]  = useState<LintResult|null>(null)
  const [lintLoading, setLintLoading] = useState(false)

  const [showHistory,    setShowHistory]    = useState(false)
  const [versions,       setVersions]       = useState<VersionEntry[]>([])
  const [versionsLoading,setVersionsLoading]= useState(false)
  const [previewVer,     setPreviewVer]     = useState<{path:string;content:string}|null>(null)
  const [historyDiff,    setHistoryDiff]    = useState<{ver:VersionEntry;verContent:string}|null>(null)
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [restoreMsg,     setRestoreMsg]     = useState('')


  const [showSearch,    setShowSearch]    = useState(false)
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchMode,    setSearchMode]    = useState<'name'|'content'>('name')
  const [searchResults, setSearchResults] = useState<SearchResult|null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout>|null>(null)

  const fileRef   = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const [uploadPct, setUploadPct] = useState<number|null>(null)
  const [uploadMsg, setUploadMsg] = useState('')

  const [copyingMsg, setCopyingMsg] = useState('')

  const [renameTarget,  setRenameTarget]  = useState<FsEntry|null>(null)
  const [renameVal,     setRenameVal]     = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFile,   setShowNewFile]   = useState(false)
  const [newFileName,   setNewFileName]   = useState('')
  const [deleteTgt,     setDeleteTgt]     = useState<FsEntry|null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError,   setActionError]   = useState('')

  // Drop highlight
  const [dropHighlight, setDropHighlight] = useState(false)

  // Re-layout Monaco when tab becomes active (fixes hidden-tab rendering)
  useEffect(() => {
    if (isActive && editorRef.current) {
      setTimeout(() => editorRef.current?.layout(), 50)
    }
  }, [isActive])

  const loadDir = useCallback(async (sid:string, p:string): Promise<void> => {
    if(!sid)return
    setLsLoading(true); setLsError('')
    try{
      const res=await api.get<LsResult>(`/servers/${sid}/fs/ls?path=${encodeURIComponent(p)}`)
      setCurPath(res.path)
      setEntries([...res.entries].sort((a,b)=>{
        if(a.type==='dir'&&b.type!=='dir')return -1
        if(a.type!=='dir'&&b.type==='dir')return 1
        return a.name.localeCompare(b.name)
      }))
    }catch(err){setLsError((err as Error).message)}
    finally{setLsLoading(false)}
  },[])

  // Bubble state up so the container can persist it in the tabs array
  useEffect(()=>{ onStateChange(serverId, curPath, openFile) },[serverId, curPath, openFile])

  const prevServerRef = useRef('')
  useEffect(()=>{
    if(prevServerRef.current===serverId)return
    const isMount = prevServerRef.current===''
    prevServerRef.current=serverId
    if(!serverId){setEntries([]);if(!isMount){setCurPath('/');setOpenFile(null);setContent('');setFileMeta(null);setIsBinary(false);setReadError('')}return}
    if(isMount){
      // On mount with a restored serverId: load the saved directory, then restore open file
      loadDir(serverId, curPath).then(()=>{
        if(initOpenFile){
          setReadLoading(true);setReadError('')
          api.get<ReadResult>(`/servers/${serverId}/fs/read?path=${encodeURIComponent(initOpenFile)}`)
            .then(res=>{
              setIsBinary(res.binary)
              const loaded=res.binary?'':(res.content??'')
              setContent(loaded);setSavedContent(loaded);setEditorInitValue(loaded)
              setFileMeta({mime:res.mime,size:res.size})
            })
            .catch(()=>setOpenFile(null))
            .finally(()=>setReadLoading(false))
        }
      })
      return
    }
    // Server changed by user: reset to root
    setCurPath('/');setEntries([]);setOpenFile(null);setContent('')
    setFileMeta(null);setIsBinary(false);setReadError('');setLintResult(null)
    loadDir(serverId,'/')
  },[serverId,loadDir])

  const openFileHandler = async(entry:FsEntry, fromPath?:string)=>{
    if(!serverId)return
    const fp=join(fromPath??curPath,entry.name)
    setOpenFile(fp);setReadLoading(true)
    setReadError('');setIsDirty(false);setShowDiff(false);setLintResult(null);setSaveMsg('')
    setShowHistory(false);setVersions([]);setPreviewVer(null);setHistoryDiff(null)
    try{
      const res=await api.get<ReadResult>(`/servers/${serverId}/fs/read?path=${encodeURIComponent(fp)}`)
      setIsBinary(res.binary)
      const loaded = res.binary ? '' : (res.content ?? '')
      setContent(loaded); setSavedContent(loaded); setEditorInitValue(loaded); setShowDiff(false)
      setFileMeta({mime:res.mime,size:res.size})
    }catch(err){setReadError((err as Error).message)}
    finally{setReadLoading(false)}
  }

  const navigateDir=(name:string)=>{ loadDir(serverId,join(curPath,name)); setOpenFile(null) }
  const navigateUp=()=>{
    const p=curPath==='/'?'/':curPath.replace(/\/$/,'').split('/').slice(0,-1).join('/')||'/'
    loadDir(serverId,p)
  }

  const saveFile=async(forceArchive?:boolean)=>{
    if(!serverId||!openFile)return
    setSaveLoading(true);setSaveMsg('')
    try{
      const res=await api.post<{ok:boolean;archived_to:string|null}>(
        `/servers/${serverId}/fs/write`,
        {path:openFile,content,archive:forceArchive??archiveOnSave}
      )
      setIsDirty(false);setSavedContent(content);setShowDiff(false)
      if(res.archived_to){
        setSaveMsg('✓ Saved + archived')
        setShowHistory(true);setPreviewVer(null);setHistoryDiff(null)
        fetchVersions(serverId,openFile)
        requestAnimationFrame(()=>requestAnimationFrame(()=>editorRef.current?.layout()))
      } else {
        setSaveMsg('✓ Saved')
        if(showHistory)fetchVersions(serverId,openFile)
      }
      setTimeout(()=>setSaveMsg(''),4000)
    }catch(err){setSaveMsg('Error: '+(err as Error).message)}
    finally{setSaveLoading(false)}
  }

  // fetchVersions: always receives current sid+file directly — no closures, no refs
  const fetchVersions=async(sid:string,file:string)=>{
    if(!sid||!file)return
    setVersionsLoading(true)
    try{
      const res=await api.get<VersionEntry[]>(`/servers/${sid}/fs/versions?path=${encodeURIComponent(file)}`)
      setVersions(Array.isArray(res)?res:[])
    }catch{setVersions([])}
    finally{setVersionsLoading(false)}
  }

  const previewVersionFile=async(v:VersionEntry)=>{
    if(!serverId)return
    setPreviewVer({path:v.path,content:'Loading…'})
    try{
      const res=await api.get<ReadResult>(`/servers/${serverId}/fs/read?path=${encodeURIComponent(v.path)}`)
      const c=res.content??''
      setPreviewVer({path:v.path,content:c})
      setHistoryDiff({ver:v,verContent:c})
    }catch(err){setPreviewVer({path:v.path,content:`Error: ${(err as Error).message}`})}
  }

  const loadVersionToEditor=async(v:VersionEntry)=>{
    if(!serverId)return
    try{
      const res=await api.get<ReadResult>(`/servers/${serverId}/fs/read?path=${encodeURIComponent(v.path)}`)
      const loaded=res.content??''
      setContent(loaded);setEditorInitValue(loaded);setIsDirty(true)
      setPreviewVer(null);setHistoryDiff(null);setShowHistory(false);setVersions([]);setShowDiff(false)
      setSaveMsg(`Loaded version ${v.modified} — edit freely, then save`)
      setTimeout(()=>setSaveMsg(''),5000)
    }catch(err){setRestoreMsg('Error loading: '+(err as Error).message)}
  }

  const restoreVersion=async(v:VersionEntry)=>{
    if(!serverId||!openFile)return
    if(!confirm(`Restore version from ${v.modified}?\nCurrent file will be archived first.`))return
    setRestoreLoading(true);setRestoreMsg('')
    try{
      await api.post(`/servers/${serverId}/fs/restore-version`,{version_path:v.path,target_path:openFile})
      const res=await api.get<ReadResult>(`/servers/${serverId}/fs/read?path=${encodeURIComponent(openFile)}`)
      const restored = res.content??''; setContent(restored); setSavedContent(restored); setEditorInitValue(restored); setIsDirty(false); setShowDiff(false)
      setRestoreMsg('✓ Restored');setPreviewVer(null);if(serverId&&openFile)fetchVersions(serverId,openFile)
      setTimeout(()=>setRestoreMsg(''),3000)
    }catch(err){setRestoreMsg('Error: '+(err as Error).message)}
    finally{setRestoreLoading(false)}
  }

  const runLint=async()=>{
    if(!serverId||!openFile)return
    setLintLoading(true);setLintResult(null)
    try{const res=await api.post<LintResult>(`/servers/${serverId}/fs/lint`,{path:openFile});setLintResult(res)}
    catch(err){setLintResult({supported:false,output:(err as Error).message,ok:false})}
    finally{setLintLoading(false)}
  }

  const closeDiff = () => {
    // Apply diff result to main editor via executeEdits so the change is undoable (Ctrl+Z works)
    const editor = editorRef.current
    if (editor) {
      const model = editor.getModel()
      if (model && model.getValue() !== content) {
        editor.pushUndoStop()
        editor.executeEdits('diff-close', [{
          range: model.getFullModelRange(),
          text: content,
          forceMoveMarkers: true,
        }])
        editor.pushUndoStop()
      }
      setTimeout(() => editor.layout(), 30) // fix layout after unhide
    }
    setShowDiff(false)
  }

  const triggerFind=   ()=>{editorRef.current?.focus();editorRef.current?.getAction('actions.find')?.run()}
  const triggerReplace=()=>{editorRef.current?.focus();editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run()}

  const handleEditorMount:OnMount=(editor,monaco)=>{
    editorRef.current=editor
    editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>saveFile())
    editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyF,()=>editor.getAction('actions.find')?.run())
    editor.onDidChangeCursorPosition(e=>setCursor({line:e.position.lineNumber,col:e.position.column}))
  }

  const triggerSearch=(q:string,mode:'name'|'content')=>{
    if(searchTimer.current)clearTimeout(searchTimer.current)
    if(!q.trim()||!serverId){setSearchResults(null);return}
    searchTimer.current=setTimeout(async()=>{
      setSearchLoading(true)
      try{
        const res=await api.get<SearchResult>(
          `/servers/${serverId}/fs/search?path=${encodeURIComponent(curPath)}&q=${encodeURIComponent(q)}&mode=${mode}`
        )
        setSearchResults(res)
      }catch{setSearchResults(null)}
      finally{setSearchLoading(false)}
    },350)
  }

  const doUpload=async(fileList:FileList)=>{
    if(!serverId||!fileList.length)return
    setUploadPct(0);setUploadMsg('')
    const form=new FormData()
    for(let i=0;i<fileList.length;i++){
      const f=fileList[i]
      const rel=(f as File&{webkitRelativePath?:string}).webkitRelativePath||f.name
      form.append('file',f,encodeURIComponent(rel))
    }
    try{
      await new Promise<void>((resolve,reject)=>{
        const xhr=new XMLHttpRequest()
        xhr.open('POST',`/api/servers/${serverId}/fs/upload?path=${encodeURIComponent(curPath)}`)
        xhr.withCredentials=true
        xhr.upload.onprogress=e=>{if(e.lengthComputable)setUploadPct(Math.round(e.loaded/e.total*100))}
        xhr.onload=()=>xhr.status<300?resolve():reject(new Error(JSON.parse(xhr.responseText)?.error??'Upload failed'))
        xhr.onerror=()=>reject(new Error('Network error'))
        xhr.send(form)
      })
      setUploadMsg(`✓ Uploaded ${fileList.length} file${fileList.length>1?'s':''}`)
      loadDir(serverId,curPath)
    }catch(err){setUploadMsg('Error: '+(err as Error).message)}
    finally{
      setUploadPct(null);setTimeout(()=>setUploadMsg(''),3000)
      if(fileRef.current)fileRef.current.value=''
      if(folderRef.current)folderRef.current.value=''
    }
  }

  const doRename=async()=>{
    if(!renameTarget||!renameVal.trim()||!serverId)return
    setActionLoading(true);setActionError('')
    try{
      await api.post(`/servers/${serverId}/fs/rename`,{from:join(curPath,renameTarget.name),to:join(curPath,renameVal.trim())})
      setRenameTarget(null);setRenameVal('');loadDir(serverId,curPath)
    }catch(err){setActionError((err as Error).message)}
    finally{setActionLoading(false)}
  }
  const doNewFolder=async()=>{
    if(!newFolderName.trim()||!serverId)return
    setActionLoading(true);setActionError('')
    try{
      await api.post(`/servers/${serverId}/fs/mkdir`,{path:join(curPath,newFolderName.trim())})
      setShowNewFolder(false);setNewFolderName('');loadDir(serverId,curPath)
    }catch(err){setActionError((err as Error).message)}
    finally{setActionLoading(false)}
  }
  const doNewFile=async()=>{
    if(!newFileName.trim()||!serverId)return
    setActionLoading(true);setActionError('')
    try{
      const fp=join(curPath,newFileName.trim())
      await api.post(`/servers/${serverId}/fs/write`,{path:fp,content:'',archive:false})
      setShowNewFile(false);setNewFileName('');loadDir(serverId,curPath)
      setOpenFile(fp);setContent('');setIsBinary(false);setFileMeta({mime:'text/plain',size:0})
    }catch(err){setActionError((err as Error).message)}
    finally{setActionLoading(false)}
  }
  const doDelete=async()=>{
    if(!deleteTgt||!serverId)return
    setActionLoading(true);setActionError('')
    try{
      const p=join(curPath,deleteTgt.name)
      await api.delete(`/servers/${serverId}/fs/delete?path=${encodeURIComponent(p)}`)
      if(openFile===p){setOpenFile(null);setContent('')}
      setDeleteTgt(null);loadDir(serverId,curPath)
    }catch(err){setActionError((err as Error).message)}
    finally{setActionLoading(false)}
  }

  // Restore a version file from .versions/ to its parent directory
  const doRestoreFromTree=async(vEntry:FsEntry)=>{
    if(!serverId)return
    // curPath ends with /.versions; parent = dirname(curPath)
    const parentDir=curPath.replace(/\/.versions\/?$/,'')
    const versionPath=join(curPath,vEntry.name)
    // Original filename: strip timestamp suffix (last .YYYY-MM-DDTHH-MM-SS part)
    const origName=vEntry.name.replace(/\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,'')
    const targetPath=join(parentDir,origName)
    setActionLoading(true);setActionError('')
    try{
      await api.post(`/servers/${serverId}/fs/restore-version`,{version_path:versionPath,target_path:targetPath})
      setRenameTarget(null)
      setActionError('')
      loadDir(serverId,curPath)
    }catch(err){setActionError((err as Error).message)}
    finally{setActionLoading(false)}
  }

  // Delete all version files in the current .versions/ directory
  const doDeleteAllVersions=async()=>{
    if(!serverId||!curPath.endsWith('/.versions'))return
    setActionLoading(true);setActionError('')
    try{
      // Delete each file; keep the directory itself
      await Promise.all(entries.filter(e=>e.type==='file').map(e=>
        api.delete(`/servers/${serverId}/fs/delete?path=${encodeURIComponent(join(curPath,e.name))}`)
      ))
      loadDir(serverId,curPath)
    }catch(err){setActionError((err as Error).message)}
    finally{setActionLoading(false)}
  }

  // ── Execute pending cross-server copy (triggered by container after confirm) ──
  useEffect(()=>{
    if(!pendingCopy||!serverId)return
    const{drag,destDir,destName}=pendingCopy
    setCopyingMsg(`Copying ${drag.entry.name}…`)
    api.post(`/servers/${serverId}/fs/copy-from`,{
      source_server_id:drag.serverId,
      source_path:drag.srcPath,
      dest_dir:destDir,
      dest_name:destName,
    })
      .then(()=>{ setCopyingMsg('✓ Copy complete'); loadDir(serverId,destDir); onCopyDone() })
      .catch(err=>{ setCopyingMsg('Copy failed: '+(err as Error).message); onCopyDone() })
      .finally(()=>setTimeout(()=>setCopyingMsg(''),3000))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pendingCopy])

  // ── Drag-and-drop handlers on tree entries ────────────────────────────────
  const handleDragStart=(e:React.DragEvent, entry:FsEntry)=>{
    if(!serverId)return
    e.dataTransfer.effectAllowed='copy'
    const serverName=servers.find(s=>s.id===serverId)?.name??serverId
    onDragStart({ tabId, serverId, serverName, srcPath:join(curPath,entry.name), entry })
  }

  const handleDragOver=(e:React.DragEvent)=>{
    if(!dragInfo||dragInfo.tabId===tabId||!serverId)return
    e.preventDefault(); e.dataTransfer.dropEffect='copy'
    setDropHighlight(true)
  }
  const handleDragLeave=()=>setDropHighlight(false)
  const handleDrop=(e:React.DragEvent, destEntry:FsEntry|null=null)=>{
    e.preventDefault(); setDropHighlight(false)
    if(!dragInfo||dragInfo.tabId===tabId||!serverId)return
    const destDir=destEntry?.type==='dir'?join(curPath,destEntry.name):curPath
    onDropped(serverId,destDir,destEntry)
  }

  const crumbs=curPath==='/'
    ?[{label:'/',path:'/'}]
    :['/',...curPath.split('/').filter(Boolean)].map((seg,i,arr)=>({
        label:seg, path:i===0?'/':'/'+arr.slice(1,i+1).join('/')
      }))
  const lang=openFile?detectLang(openFile):'plaintext'
  const selStyle:React.CSSProperties={padding:'4px 8px',borderRadius:4,border:`1px solid ${C.inputBdr}`,background:C.inputBg,color:C.inputTxt,fontSize:12}

  return(
    <div style={{display:isActive?'flex':'none',flexDirection:'column',flex:1,minHeight:0}}>
      {/* ── Top bar ── */}
      <div style={{display:'flex',alignItems:'center',gap:6,padding:'5px 10px',
        borderBottom:`1px solid ${C.border}`,background:C.sidebarBg,flexShrink:0,
        overflowX:'auto',flexWrap:'nowrap',justifyContent:'flex-start'}}>
        {serverId ? (()=>{
          const srv=servers.find(s=>s.id===serverId)
          return(
            <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
              <div style={{display:'flex',alignItems:'center',gap:6,padding:'3px 10px',
                borderRadius:4,border:`1px solid ${C.accent}`,background:'rgba(88,166,255,0.08)',
                fontSize:12,color:C.text,maxWidth:220}}>
                <span style={{width:7,height:7,borderRadius:'50%',background:C.success,flexShrink:0}}/>
                <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {srv?.name??'Server'} <span style={{color:C.muted,fontSize:11}}>({srv?.hostname})</span>
                </span>
              </div>
              <Btn onClick={()=>setServerId('')} title='Disconnect from server'>✕ Disconnect</Btn>
              <select value={serverId} onChange={e=>setServerId(e.target.value)}
                style={{...selStyle,fontSize:11,padding:'2px 6px',flexShrink:0}}
                title='Switch server'>
                {servers.filter(s=>s.is_active).map(s=>(
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )
        })() : (
          <select value='' onChange={e=>setServerId(e.target.value)} style={{...selStyle,width:220,flexShrink:0}}>
            <option value=''>— Select server —</option>
            {servers.filter(s=>s.is_active).map(s=>(
              <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>
            ))}
          </select>
        )}
        {openFile&&(<>
          <label style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:C.sidebarTxt,cursor:'pointer'}}>
            <input type='checkbox' checked={archiveOnSave} onChange={e=>setArchiveOnSave(e.target.checked)} style={{accentColor:C.accent}}/>
            Archive on save
          </label>
          <Btn bg='#1a7f37' onClick={()=>saveFile()} disabled={saveLoading||!isDirty}>{saveLoading?'Saving…':'💾 Save'}</Btn>
          <Btn onClick={()=>setShowDiff(v=>!v)} disabled={!isDirty} bg={showDiff?'#7c3aed':undefined} title='Show diff before saving'>⟺ Diff</Btn>
          <Btn onClick={()=>{
            if(showHistory){
              setShowHistory(false);setPreviewVer(null);setHistoryDiff(null);setVersions([])
              requestAnimationFrame(()=>requestAnimationFrame(()=>editorRef.current?.layout()))
              return
            }
            setShowHistory(true);setPreviewVer(null);setHistoryDiff(null)
            if(serverId&&openFile)fetchVersions(serverId,openFile)
            requestAnimationFrame(()=>requestAnimationFrame(()=>editorRef.current?.layout()))
          }} bg={showHistory?'#1f6feb':undefined}>📋 History</Btn>
          <Btn onClick={triggerFind} title='Find (Ctrl+F)'>🔍 Find</Btn>
          <Btn onClick={triggerReplace} title='Find & Replace'>⇄ Replace</Btn>
          <Btn onClick={runLint} disabled={lintLoading}>{lintLoading?'…':'✓ Lint'}</Btn>
        </>)}
      </div>

      {/* ── Body ── */}
      <div style={{display:'flex',flex:1,minHeight:0}}>

        {/* ── Sidebar ── */}
        <div style={{width:270,flexShrink:0,display:'flex',flexDirection:'column',
          borderRight:`1px solid ${C.border}`,background:C.card,overflow:'hidden',
          outline:dropHighlight?`2px solid ${C.accent}`:'none',
          transition:'outline 0.1s'}}
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={e=>handleDrop(e,null)}>

          {/* Toolbar */}
          <div style={{display:'flex',gap:4,padding:'5px 7px',borderBottom:`1px solid ${C.border}`,flexWrap:'wrap'}}>
            <Btn onClick={()=>{setShowSearch(!showSearch);setSearchQuery('');setSearchResults(null)}} disabled={!serverId}>🔍</Btn>
            <Btn onClick={()=>{setShowNewFolder(true);setActionError('')}} disabled={!serverId}>📁+</Btn>
            <Btn onClick={()=>{setShowNewFile(true);setActionError('')}} disabled={!serverId}>📄+</Btn>
            <Btn onClick={()=>fileRef.current?.click()} disabled={!serverId}>⬆ File</Btn>
            <Btn onClick={()=>folderRef.current?.click()} disabled={!serverId}>⬆ Folder</Btn>
            <Btn onClick={()=>loadDir(serverId,curPath)} disabled={!serverId||lsLoading}>↺</Btn>
          </div>
          <input ref={fileRef} type='file' multiple hidden onChange={e=>e.target.files&&doUpload(e.target.files)}/>
          <input ref={folderRef} type='file' multiple hidden
            // @ts-expect-error webkitdirectory non-standard
            webkitdirectory='' onChange={e=>e.target.files&&doUpload(e.target.files)}/>

          {/* Status banners */}
          {(uploadPct!==null||uploadMsg)&&(
            <div style={{padding:'4px 8px',borderBottom:`1px solid ${C.border}`,background:C.bg}}>
              {uploadPct!==null&&<div style={{height:4,background:C.border,borderRadius:2,overflow:'hidden'}}>
                <div style={{height:'100%',width:`${uploadPct}%`,background:C.accent,transition:'width 0.2s'}}/>
              </div>}
              {uploadMsg&&<div style={{fontSize:11,marginTop:2,color:uploadMsg.startsWith('Error')?C.error:C.success}}>{uploadMsg}</div>}
            </div>
          )}
          {copyingMsg&&(
            <div style={{padding:'4px 8px',fontSize:11,borderBottom:`1px solid ${C.border}`,
              color:copyingMsg.startsWith('Copy failed')?C.error:C.success,background:C.bg}}>
              {copyingMsg}
            </div>
          )}
          {dropHighlight&&dragInfo&&dragInfo.tabId!==tabId&&(
            <div style={{padding:'4px 8px',fontSize:11,borderBottom:`1px solid ${C.border}`,
              color:C.accent,background:'rgba(88,166,255,0.08)'}}>
              ↓ Drop to copy from {dragInfo.serverName}
            </div>
          )}

          {/* Search */}
          {showSearch&&(
            <div style={{padding:'6px 8px',borderBottom:`1px solid ${C.border}`,background:C.bg}}>
              <div style={{display:'flex',gap:4,marginBottom:4}}>
                <IInput autoFocus value={searchQuery} onChange={v=>{setSearchQuery(v);triggerSearch(v,searchMode)}} placeholder='Search…'/>
                <select value={searchMode} onChange={e=>{const m=e.target.value as 'name'|'content';setSearchMode(m);triggerSearch(searchQuery,m)}} style={{...selStyle,padding:'2px 4px'}}>
                  <option value='name'>Name</option><option value='content'>Content</option>
                </select>
              </div>
              {searchLoading&&<div style={{fontSize:11,color:C.muted}}>Searching…</div>}
              {searchResults&&(
                <div style={{maxHeight:200,overflowY:'auto'}}>
                  {searchResults.matches.length===0?<div style={{fontSize:11,color:C.muted}}>No results</div>
                    :searchResults.matches.map(m=>(
                      <div key={m} style={{fontSize:11,padding:'2px 4px',cursor:'pointer',borderRadius:3,color:C.accent}}
                        onClick={()=>{
                          setShowSearch(false)
                          const parts=m.split('/'),name=parts.pop()??'',dir=parts.join('/')||'/'
                          loadDir(serverId,dir)
                          setTimeout(()=>{if(!m.endsWith('/'))openFileHandler({name,type:'file',permissions:'',owner:'',size:0,modified:''},dir)},400)
                        }} title={m}>{m.length>36?'…'+m.slice(-35):m}</div>
                    ))
                  }
                  {searchResults.mode==='content'&&searchResults.grep_lines.slice(0,10).map((gl,i)=>(
                    <div key={i} style={{fontSize:10,color:C.muted,padding:'1px 4px',fontFamily:'monospace'}}>{gl}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* New folder/file */}
          {showNewFolder&&(
            <div style={{padding:'6px 8px',borderBottom:`1px solid ${C.border}`,background:C.bg}}>
              <div style={{fontSize:11,marginBottom:4,color:C.muted}}>New folder in {curPath}</div>
              <div style={{display:'flex',gap:4}}>
                <IInput autoFocus value={newFolderName} onChange={setNewFolderName} placeholder='folder-name'
                  onKeyDown={e=>{if(e.key==='Enter')doNewFolder();if(e.key==='Escape')setShowNewFolder(false)}}/>
                <Btn bg='#1a7f37' onClick={doNewFolder} disabled={actionLoading}>✓</Btn>
                <Btn onClick={()=>{setShowNewFolder(false);setActionError('')}}>✕</Btn>
              </div>
              {actionError&&<div style={{fontSize:11,color:C.error,marginTop:4}}>{actionError}</div>}
            </div>
          )}
          {showNewFile&&(
            <div style={{padding:'6px 8px',borderBottom:`1px solid ${C.border}`,background:C.bg}}>
              <div style={{fontSize:11,marginBottom:4,color:C.muted}}>New file in {curPath}</div>
              <div style={{display:'flex',gap:4}}>
                <IInput autoFocus value={newFileName} onChange={setNewFileName} placeholder='filename.ext'
                  onKeyDown={e=>{if(e.key==='Enter')doNewFile();if(e.key==='Escape')setShowNewFile(false)}}/>
                <Btn bg='#1a7f37' onClick={doNewFile} disabled={actionLoading}>✓</Btn>
                <Btn onClick={()=>{setShowNewFile(false);setActionError('')}}>✕</Btn>
              </div>
              {actionError&&<div style={{fontSize:11,color:C.error,marginTop:4}}>{actionError}</div>}
            </div>
          )}

          {/* Breadcrumb */}
          <div style={{display:'flex',alignItems:'center',gap:2,padding:'4px 8px',
            borderBottom:`1px solid ${C.border}`,fontSize:11,color:C.muted,flexWrap:'wrap',background:C.bg}}>
            {crumbs.map((bc,i)=>(
              <span key={bc.path}>
                {i>0&&<span style={{margin:'0 2px'}}>/</span>}
                <span style={{cursor:'pointer',color:i===crumbs.length-1?C.text:C.accent}}
                  onClick={()=>loadDir(serverId,bc.path)}>{bc.label}</span>
              </span>
            ))}
          </div>

          {/* Tree */}
          <div style={{flex:1,overflowY:'auto'}}>
            {!serverId&&<div style={{padding:16,color:C.muted,fontSize:12}}>Select a server to browse.</div>}
            {lsLoading&&<div style={{padding:'8px 12px',color:C.muted,fontSize:12}}>Loading…</div>}
            {lsError&&<div style={{padding:'8px 12px',color:C.error,fontSize:12}}>{lsError}</div>}
            {curPath!=='/'&&!lsLoading&&(
              <div style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px',cursor:'pointer',color:C.muted,margin:'1px 4px'}} onClick={navigateUp}>
                <span>⬆</span><span style={{fontSize:12}}>..</span>
              </div>
            )}
            {entries.map(e=>{
              const fp=join(curPath,e.name); const active=openFile===fp
              return(
                <div key={e.name}
                  draggable={!!serverId}
                  onDragStart={ev=>handleDragStart(ev,e)}
                  onDragOver={ev=>{if(e.type==='dir'){ev.stopPropagation();if(!dragInfo||dragInfo.tabId===tabId||!serverId)return;ev.preventDefault();ev.dataTransfer.dropEffect='copy'}}}
                  onDrop={ev=>{ev.stopPropagation();if(e.type==='dir')handleDrop(ev,e)}}
                  style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px',cursor:'pointer',
                    userSelect:'none',borderRadius:4,margin:'1px 4px',
                    background:active?C.sidebarActive:'transparent',
                    color:active?C.sidebarActTxt:C.text}}
                  onClick={()=>e.type==='dir'?navigateDir(e.name):openFileHandler(e)}
                  onContextMenu={ev=>{ev.preventDefault();setRenameTarget(e);setRenameVal(e.name);setActionError('')}}
                  title={`${e.permissions} ${e.owner}  ${fmt(e.size)}  ${e.modified}\nDrag to copy to another tab\nRight-click to rename/delete`}>
                  <EntryIcon e={e}/>
                  <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:12}}>{e.name}</span>
                  <span style={{fontSize:10,color:C.muted,flexShrink:0}}>{e.type==='file'?fmt(e.size):''}</span>
                </div>
              )
            })}
          </div>

          {/* Delete-all-versions button when browsing .versions/ */}
          {curPath.endsWith('/.versions')&&entries.some(e=>e.type==='file')&&(
            <div style={{padding:'4px 8px',borderTop:`1px solid ${C.border}`,background:C.card,flexShrink:0}}>
              <Btn bg='#b91c1c' onClick={doDeleteAllVersions} disabled={actionLoading} full>
                🗑 Delete all versions ({entries.filter(e=>e.type==='file').length})
              </Btn>
              {actionError&&!renameTarget&&<div style={{fontSize:11,color:C.error,marginTop:4}}>{actionError}</div>}
            </div>
          )}

          {/* Rename/delete panel */}
          {renameTarget&&(
            <div style={{padding:'6px 8px',borderTop:`1px solid ${C.border}`,background:C.card,flexShrink:0}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:4}}>Rename: <strong style={{color:C.text}}>{renameTarget.name}</strong></div>
              <div style={{display:'flex',gap:4,marginBottom:6}}>
                <IInput autoFocus value={renameVal} onChange={setRenameVal}
                  onKeyDown={e=>{if(e.key==='Enter')doRename();if(e.key==='Escape')setRenameTarget(null)}}/>
                <Btn bg='#1a7f37' onClick={doRename} disabled={actionLoading}>✓</Btn>
                <Btn onClick={()=>{setRenameTarget(null);setActionError('')}}>✕</Btn>
              </div>
              {curPath.endsWith('/.versions')&&renameTarget.type==='file'&&(
                <div style={{marginBottom:4}}>
                  <Btn bg='#1a7f37' onClick={()=>doRestoreFromTree(renameTarget)} disabled={actionLoading} full>
                    ⎌ Restore to parent folder
                  </Btn>
                </div>
              )}
              <Btn bg='#0e7490' onClick={()=>{
                const fp=join(curPath,renameTarget.name)
                window.location.href=`/api/servers/${serverId}/fs/download?path=${encodeURIComponent(fp)}`
              }} full>⬇ Download {renameTarget.type==='dir'?'(.tar.gz)':''}</Btn>
              <Btn bg='#b91c1c' onClick={()=>{setDeleteTgt(renameTarget);setRenameTarget(null)}} full>
                🗑 Delete {renameTarget.type==='dir'?'folder':'file'}
              </Btn>
              {actionError&&<div style={{fontSize:11,color:C.error,marginTop:4}}>{actionError}</div>}
            </div>
          )}
        </div>

        {/* ── Editor + history ── */}
        <div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0,background:C.bg}}>
          {/* File tab bar */}
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 12px',
            borderBottom:`1px solid ${C.border}`,background:C.sidebarBg,flexShrink:0,minHeight:30}}>
            {openFile?(
              <>
                <span style={{fontSize:12,color:C.text,fontFamily:'monospace',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {isDirty&&<span style={{color:C.warning,marginRight:4}}>●</span>}{openFile}
                </span>
                <div style={{flex:1}}/>
                {saveMsg&&<span style={{fontSize:11,color:saveMsg.startsWith('Error')?C.error:C.success,flexShrink:0}}>{saveMsg}</span>}
              </>
            ):(
              <span style={{fontSize:12,color:C.muted}}>No file open — click a file in the tree</span>
            )}
          </div>

          {/* Lint */}
          {lintResult&&(
            <div style={{padding:'4px 12px',fontSize:11,flexShrink:0,
              background:lintResult.ok?'rgba(46,160,67,0.1)':'rgba(248,81,73,0.1)',
              borderBottom:`1px solid ${C.border}`,
              color:lintResult.ok?C.success:C.error,fontFamily:'monospace',whiteSpace:'pre-wrap',maxHeight:90,overflowY:'auto'}}>
              {!lintResult.supported?'⚠ No linter for this file type':lintResult.ok?'✓ No syntax errors':lintResult.output}
            </div>
          )}

          <div style={{flex:1,minHeight:0,position:'relative',overflow:'hidden'}}>
            {/* Monaco — always full width; history panel overlays on top */}
            <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column'}}>
              {!openFile&&!readLoading&&(
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:C.muted,flexDirection:'column',gap:8}}>
                  <span style={{fontSize:36}}>📂</span>
                  <span style={{fontSize:13}}>{serverId?'Select a file to edit':'Select a server first'}</span>
                  {dragInfo&&dragInfo.tabId!==tabId&&serverId&&(
                    <span style={{fontSize:12,color:C.accent}}>↓ Or drop a file here from another tab</span>
                  )}
                </div>
              )}
              {readLoading&&<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:C.muted}}>Loading…</div>}
              {readError&&<div style={{padding:16,color:C.error,fontSize:13}}>Error: {readError}</div>}
              {isBinary&&!readLoading&&(
                <div style={{padding:16,color:C.muted,fontSize:13}}>
                  <strong style={{color:C.text}}>Binary file</strong> ({fileMeta?.mime})<br/>
                  <span style={{fontSize:12}}>Size: {fileMeta?fmt(fileMeta.size):'?'}</span>
                </div>
              )}
              {/* Main editor — always mounted when a text file is open so undo stack is preserved */}
              <div style={{display:openFile&&!isBinary&&!readLoading&&!readError&&!showDiff?'flex':'none',flex:1,flexDirection:'column'}}>
                <Editor height='100%' language={lang} value={editorInitValue} theme='vs-dark'
                  onMount={handleEditorMount}
                  onChange={val=>{setContent(val??'');setIsDirty(true);if(lintResult)setLintResult(null)}}
                  options={{fontSize:13,fontFamily:"'Cascadia Code','JetBrains Mono','Fira Code',monospace",
                    minimap:{enabled:true},wordWrap:'on',lineNumbers:'on',
                    renderWhitespace:'boundary',bracketPairColorization:{enabled:true},
                    formatOnPaste:false,scrollBeyondLastLine:false,tabSize:2,insertSpaces:true,
                    find:{autoFindInSelection:'never',seedSearchStringFromSelection:'selection'}}}/>
              </div>
              {/* Diff view — mounted only when open; close via closeDiff() to apply changes undoably */}
              {openFile&&!isBinary&&!readLoading&&!readError&&showDiff&&(
                <div style={{display:'flex',flexDirection:'column',flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,padding:'4px 10px',
                    background:'rgba(124,58,237,0.12)',borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
                    <span style={{fontSize:11,color:'#a78bfa',fontWeight:600}}>⟺ Diff view</span>
                    <span style={{fontSize:11,color:C.muted}}>— left: saved on server · right: your edits</span>
                    <div style={{flex:1}}/>
                    <Btn bg='#1a7f37' onClick={()=>saveFile()} disabled={saveLoading}>
                      {saveLoading?'Saving…':'💾 Save changes'}
                    </Btn>
                    <Btn onClick={closeDiff}>✕ Close diff</Btn>
                  </div>
                  <div style={{flex:1,minHeight:0}}>
                    <DiffEditor
                      height='100%' language={lang} theme='vs-dark'
                      original={savedContent} modified={content}
                      options={{
                        fontSize:13,fontFamily:"'Cascadia Code','JetBrains Mono','Fira Code',monospace",
                        readOnly:false,renderSideBySide:true,wordWrap:'on',
                        minimap:{enabled:false},scrollBeyondLastLine:false,
                        renderOverviewRuler:false,
                      }}
                      onMount={(diffEditor)=>{
                        const mod=diffEditor.getModifiedEditor()
                        mod.onDidChangeModelContent(()=>{
                          setContent(mod.getValue()); setIsDirty(true)
                        })
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Version history panel — absolute overlay on right edge, no Monaco resize needed */}
            {showHistory&&openFile&&(
              <div style={{position:'absolute',top:0,right:0,bottom:0,width:300,
                display:'flex',flexDirection:'column',
                borderLeft:`1px solid ${C.border}`,background:C.card,overflow:'hidden',zIndex:10}}>
                <div style={{padding:'5px 8px',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
                  <span style={{fontWeight:600,fontSize:12,color:C.text}}>📋 Version History</span>
                  <div style={{flex:1}}/>
                  <Btn small onClick={()=>{if(serverId&&openFile)fetchVersions(serverId,openFile)}} disabled={versionsLoading} title='Refresh'>↺</Btn>
                  <Btn small onClick={()=>{setShowHistory(false);setPreviewVer(null);setHistoryDiff(null);setVersions([]);requestAnimationFrame(()=>requestAnimationFrame(()=>editorRef.current?.layout()))}}>✕</Btn>
                </div>
                {restoreMsg&&<div style={{padding:'3px 8px',fontSize:11,flexShrink:0,borderBottom:`1px solid ${C.border}`,
                  color:restoreMsg.startsWith('Error')?C.error:C.success}}>{restoreMsg}</div>}
                <div style={{fontSize:10,padding:'3px 8px',color:C.muted,borderBottom:`1px solid ${C.border}`,background:C.bg,flexShrink:0}}>
                  📁 <code style={{color:C.accent}}>{openFile ? openFile.replace(/\/[^/]+$/, '/.versions/') : ''}</code>
                </div>
                {versionsLoading&&<div style={{padding:'8px',color:C.muted,fontSize:11,flexShrink:0}}>Loading…</div>}
                {!versionsLoading&&versions.length===0&&(
                  <div style={{padding:'12px 8px',color:C.muted,fontSize:11,flexShrink:0}}>
                    No versions found in <code style={{color:C.accent}}>.versions/</code>.<br/>
                    Enable <em>Archive on save</em> and save to create snapshots.
                  </div>
                )}

                {/* Diff overlay when a version is selected */}
                {historyDiff&&(
                  <div style={{flex:1,display:'flex',flexDirection:'column',minHeight:0}}>
                    <div style={{padding:'4px 8px',fontSize:11,borderBottom:`1px solid ${C.border}`,
                      background:'rgba(124,58,237,0.1)',color:'#a78bfa',flexShrink:0,display:'flex',alignItems:'center',gap:6}}>
                      <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                        ⟺ {historyDiff.ver.modified}
                      </span>
                      <Btn small bg='#1f6feb' onClick={()=>loadVersionToEditor(historyDiff.ver)} title='Load this version into editor'>📝 Load</Btn>
                      <Btn small bg='#1a7f37' onClick={()=>restoreVersion(historyDiff.ver)} disabled={restoreLoading} title='Restore to server'>⎌</Btn>
                      <Btn small onClick={()=>{setHistoryDiff(null);setPreviewVer(null)}}>✕</Btn>
                    </div>
                    <div style={{fontSize:10,padding:'2px 8px',color:C.muted,flexShrink:0,borderBottom:`1px solid ${C.border}`}}>
                      left: version · right: current
                    </div>
                    <div style={{flex:1,minHeight:0}}>
                      <DiffEditor
                        height='100%' language={lang} theme='vs-dark'
                        original={historyDiff.verContent} modified={content}
                        options={{
                          readOnly:true, renderSideBySide:false,
                          fontSize:11, minimap:{enabled:false},
                          scrollBeyondLastLine:false, wordWrap:'on',
                          renderOverviewRuler:false,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Version list */}
                {!historyDiff&&(
                  <div style={{flex:1,overflowY:'auto'}}>
                    {versions.map((v,i)=>{
                      const isSelected=previewVer?.path===v.path
                      const sizeDelta=i<versions.length-1?v.size-versions[i+1].size:null
                      return(
                        <div key={v.path}
                          style={{borderBottom:`1px solid ${C.border}`,padding:'6px 8px',
                            background:isSelected?'rgba(88,166,255,0.08)':'transparent',
                            cursor:'pointer'}}
                          onClick={()=>previewVersionFile(v)}>
                          <div style={{display:'flex',alignItems:'flex-start',gap:4}}>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:11,color:C.text,fontFamily:'monospace',
                                overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
                                fontWeight:isSelected?600:400}}>
                                {i===0&&<span style={{color:C.accent,marginRight:4,fontSize:10}}>LATEST</span>}
                                {v.modified}
                              </div>
                              <div style={{fontSize:10,color:C.muted,marginTop:1,display:'flex',gap:6}}>
                                <span>{fmt(v.size)}</span>
                                {sizeDelta!==null&&<span style={{color:sizeDelta>0?C.success:sizeDelta<0?C.error:C.muted}}>
                                  {sizeDelta>0?'+':''}{sizeDelta} B
                                </span>}
                              </div>
                            </div>
                            <div style={{display:'flex',gap:2,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                              <Btn small bg='#1f6feb' onClick={()=>loadVersionToEditor(v)} title='Load into editor to edit'>📝</Btn>
                              <Btn small bg='#1a7f37' onClick={()=>restoreVersion(v)} disabled={restoreLoading} title='Restore: overwrite current file on server'>⎌</Btn>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Status bar */}
          <div style={{display:'flex',alignItems:'center',gap:14,padding:'3px 10px',
            background:C.accent,color:'#fff',fontSize:11,flexShrink:0}}>
            <span>Ln {cursor.line}, Col {cursor.col}</span>
            {openFile&&<><span>|</span><span>{lang}</span></>}
            {fileMeta&&<><span>|</span><span>{fileMeta.mime}</span><span>|</span><span>{fmt(fileMeta.size)}</span></>}
            {isDirty&&<><span>|</span><span style={{color:'#ffd700'}}>● Unsaved</span></>}
            {archiveOnSave&&openFile&&<><span>|</span><span style={{opacity:0.7}}>🗄 Archive on</span></>}
          </div>
        </div>
      </div>

      {/* Delete confirm */}
      {deleteTgt&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.65)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:999}}>
          <div style={{background:C.card,border:`1px solid ${C.cardBdr}`,borderRadius:8,padding:24,minWidth:300,maxWidth:460}}>
            <div style={{fontWeight:600,fontSize:14,marginBottom:8,color:C.text}}>Confirm Delete</div>
            <div style={{fontSize:13,color:C.muted,marginBottom:16}}>
              Permanently delete <strong style={{color:C.text}}>{deleteTgt.name}</strong>
              {deleteTgt.type==='dir'&&' and all its contents'}?<br/>
              <span style={{fontSize:11,color:C.error}}>This cannot be undone.</span>
            </div>
            {actionError&&<div style={{fontSize:12,color:C.error,marginBottom:8}}>{actionError}</div>}
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <Btn onClick={()=>{setDeleteTgt(null);setActionError('')}}>Cancel</Btn>
              <Btn bg='#b91c1c' onClick={doDelete} disabled={actionLoading}>{actionLoading?'Deleting…':'🗑 Delete'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FileManager — container with tab bar + drag-drop orchestration
// ─────────────────────────────────────────────────────────────────────────────
const LS_TABS   = 'fm_tabs'
const LS_ACTIVE = 'fm_activeTab'

function loadStoredTabs(): TabMeta[] {
  try { return JSON.parse(localStorage.getItem(LS_TABS)??'[]') } catch { return [] }
}

export default function FileManager() {
  const [servers, setServers] = useState<Server[]>([])
  const [tabs,    setTabs]    = useState<TabMeta[]>(() => {
    const stored = loadStoredTabs()
    return stored.length ? stored : [{ id: uid(), label: 'Tab 1' }]
  })
  const [activeId, setActiveId] = useState<string>(() => {
    const stored = localStorage.getItem(LS_ACTIVE) ?? ''
    const storedTabs = loadStoredTabs()
    return storedTabs.find(t=>t.id===stored) ? stored : (storedTabs[0]?.id ?? '')
  })

  // Make sure activeId is always valid
  useEffect(() => {
    if (!tabs.find(t=>t.id===activeId) && tabs.length) setActiveId(tabs[0].id)
  }, [tabs, activeId])

  // Persist tabs
  useEffect(() => { localStorage.setItem(LS_TABS, JSON.stringify(tabs)) }, [tabs])
  useEffect(() => { localStorage.setItem(LS_ACTIVE, activeId) }, [activeId])

  useEffect(() => { api.get<Server[]>('/servers').then(r => setServers(r.filter(s => s.os_type === 'linux'))).catch(()=>{}) }, [])

  // ── Drag state ────────────────────────────────────────────────────────────
  const dragInfoRef = useRef<DragInfo|null>(null)
  const [dragInfo, setDragInfo] = useState<DragInfo|null>(null)

  const handleDragStart = useCallback((info: DragInfo) => {
    dragInfoRef.current = info
    setDragInfo(info)
  }, [])

  const handleDragEnd = useCallback(() => {
    dragInfoRef.current = null
    setDragInfo(null)
  }, [])

  // Tab hover-to-switch while dragging
  const hoverTimer = useRef<ReturnType<typeof setTimeout>|null>(null)
  const handleTabDragOver = (tabId: string) => {
    if (!dragInfo || dragInfo.tabId === tabId) return
    if (hoverTimer.current) return // already queued
    hoverTimer.current = setTimeout(() => {
      setActiveId(tabId)
      hoverTimer.current = null
    }, 600)
  }
  const handleTabDragLeave = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
  }

  // ── Drop confirm state ────────────────────────────────────────────────────
  const [dropConfirm, setDropConfirm] = useState<DropConfirmState|null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [pendingCopy, setPendingCopy] = useState<{tabId:string; drag:DragInfo; destDir:string; destName?:string}|null>(null)

  const handleDropped = useCallback(async (destServerId:string, destDir:string, _destEntry:FsEntry|null) => {
    const drag = dragInfoRef.current
    if (!drag) return
    const destName = drag.entry.name

    // Check for duplicates on the destination server
    const destPath = destDir.replace(/\/$/,'') + '/' + destName
    try {
      const res = await api.get<{exists:boolean;type:'file'|'dir'|null}>(
        `/servers/${destServerId}/fs/exists?path=${encodeURIComponent(destPath)}`
      )
      if (res.exists && res.type) {
        const serverName = servers.find(s=>s.id===destServerId)?.name ?? destServerId
        setDropConfirm({
          drag, destServerId, destServerName: serverName,
          destDir, existingType: res.type, proposedName: destName,
        })
        setRenameInput(destName.replace(/(\.[^.]+)$/, '_copy$1') || destName + '_copy')
      } else {
        // No duplicate — copy immediately
        setPendingCopy({ tabId: activeId, drag, destDir })
      }
    } catch {
      // On error, attempt anyway
      setPendingCopy({ tabId: activeId, drag, destDir })
    }
  }, [activeId, servers])

  const confirmReplace = () => {
    if (!dropConfirm) return
    setPendingCopy({ tabId: activeId, drag: dropConfirm.drag, destDir: dropConfirm.destDir })
    setDropConfirm(null)
  }
  const confirmRename = () => {
    if (!dropConfirm||!renameInput.trim()) return
    setPendingCopy({ tabId: activeId, drag: dropConfirm.drag, destDir: dropConfirm.destDir, destName: renameInput.trim() })
    setDropConfirm(null)
  }
  const confirmSkip = () => setDropConfirm(null)

  const handleCopyDone = useCallback(() => setPendingCopy(null), [])

  // ── Tab management ────────────────────────────────────────────────────────
  const handleTabStateChange = useCallback((tabId: string, serverId: string, curPath: string, openFile: string | null) => {
    setTabs(prev => prev.map(t => t.id === tabId
      ? { ...t, serverId, curPath, openFile: openFile ?? undefined }
      : t
    ))
  }, [])

  const addTab = () => {
    const id = uid()
    const n = tabs.length + 1
    setTabs(t => [...t, { id, label: `Tab ${n}` }])
    setActiveId(id)
  }

  const duplicateTab = (srcId: string) => {
    const src = tabs.find(t => t.id === srcId)
    const newId = uid()
    const label = src ? `${src.label} (copy)` : `Tab ${tabs.length + 1}`
    setTabs(t => [...t, { id: newId, label, serverId: src?.serverId, curPath: src?.curPath }])
    setActiveId(newId)
  }

  const closeTab = (id: string) => {
    if (tabs.length === 1) return // keep at least one tab
    setTabs(t => t.filter(x => x.id !== id))
    if (activeId === id) {
      const idx = tabs.findIndex(t => t.id === id)
      setActiveId(tabs[idx > 0 ? idx - 1 : 1]?.id ?? '')
    }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:C.bg, fontSize:13 }}
      onDragEnd={handleDragEnd}>

      {/* ── Tab bar ── */}
      <div style={{ display:'flex', alignItems:'stretch', borderBottom:`1px solid ${C.border}`,
        background:C.sidebarBg, flexShrink:0, minHeight:36 }}>

        <div style={{ display:'flex', flex:1, alignItems:'stretch', overflowX:'auto' }}>
          {tabs.map(tab => {
            const isActive = tab.id === activeId
            return (
              <div key={tab.id}
                onClick={() => setActiveId(tab.id)}
                onDragOver={e => { e.preventDefault(); handleTabDragOver(tab.id) }}
                onDragLeave={handleTabDragLeave}
                style={{
                  display:'flex', alignItems:'center', gap:6, padding:'0 14px',
                  cursor:'pointer', userSelect:'none', minWidth:100, maxWidth:180,
                  borderRight:`1px solid ${C.border}`,
                  background: isActive ? C.bg : 'transparent',
                  borderBottom: isActive ? `2px solid ${C.accent}` : '2px solid transparent',
                  color: isActive ? C.text : C.sidebarTxt,
                  transition:'background 0.1s',
                  // Glow when drag-hoverable
                  outline: dragInfo && dragInfo.tabId !== tab.id ? `1px solid ${C.accent}` : 'none',
                  outlineOffset: -1,
                }}>
                <span style={{ fontSize:12 }}>⊟</span>
                <span style={{ fontSize:11, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {tab.label}
                </span>
                <span
                  onClick={e => { e.stopPropagation(); duplicateTab(tab.id) }}
                  style={{ fontSize:11, color:C.muted, padding:'1px 3px', lineHeight:1, borderRadius:3 }}
                  title='Duplicate tab'
                >⧉</span>
                {tabs.length > 1 && (
                  <span
                    onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                    style={{ fontSize:10, color:C.muted, padding:'1px 3px', lineHeight:1, borderRadius:3 }}
                    title='Close tab'
                  >✕</span>
                )}
              </div>
            )
          })}
        </div>

        {/* Add tab button */}
        <button onClick={addTab} title='New tab' style={{
          display:'flex', alignItems:'center', gap:5,
          padding:'0 12px', background:C.accent, border:'none',
          borderLeft:`1px solid ${C.border}`, color:'#fff', cursor:'pointer',
          fontSize:13, fontWeight:600, flexShrink:0, height:'100%',
        }}>+ New Tab</button>

        {/* Drag hint */}
        {dragInfo && (
          <div style={{ display:'flex', alignItems:'center', padding:'0 12px', fontSize:11, color:C.accent, flexShrink:0 }}>
            Hover a tab to switch → drop to copy
          </div>
        )}
      </div>

      {/* ── Tab panels (all mounted, only active is shown) ── */}
      <div style={{ flex:1, display:'flex', minHeight:0 }}>
        {tabs.map(tab => (
          <FileManagerTab
            key={tab.id}
            tabId={tab.id}
            isActive={tab.id === activeId}
            servers={servers}
            initServerId={tab.serverId ?? ''}
            initCurPath={tab.curPath ?? '/'}
            initOpenFile={tab.openFile ?? null}
            onStateChange={(s,p,f) => handleTabStateChange(tab.id, s, p, f)}
            onDragStart={handleDragStart}
            dragInfo={dragInfo}
            onDropped={handleDropped}
            pendingCopy={pendingCopy?.tabId === tab.id ? pendingCopy : null}
            onCopyDone={handleCopyDone}
          />
        ))}
      </div>

      {/* ── Duplicate-check modal ── */}
      {dropConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', display:'flex',
          alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div style={{ background:C.card, border:`1px solid ${C.cardBdr}`, borderRadius:8,
            padding:24, minWidth:380, maxWidth:520 }}>
            <div style={{ fontWeight:600, fontSize:14, marginBottom:12, color:C.text }}>
              ⚠ Duplicate Detected
            </div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>
              <strong style={{color:C.text}}>{dropConfirm.drag.entry.name}</strong>
              {' '}({dropConfirm.drag.entry.type==='dir'?'folder':'file'}) already exists at:
            </div>
            <div style={{ fontSize:12, fontFamily:'monospace', color:C.accent, marginBottom:4,
              background:C.bg, padding:'4px 8px', borderRadius:4, border:`1px solid ${C.border}` }}>
              {dropConfirm.destServerName}:{dropConfirm.destDir}/{dropConfirm.drag.entry.name}
            </div>
            <div style={{ fontSize:11, color:C.muted, marginBottom:16 }}>
              Existing item is a <strong style={{color:C.text}}>{dropConfirm.existingType}</strong>.
              {' '}From: <strong style={{color:C.text}}>{dropConfirm.drag.serverName}</strong>
            </div>

            {/* Rename input */}
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Copy with a new name:</div>
              <div style={{ display:'flex', gap:6 }}>
                <IInput value={renameInput} onChange={setRenameInput}
                  onKeyDown={e=>{ if(e.key==='Enter') confirmRename() }}
                  placeholder='new-name.ext' />
                <Btn bg='#1a7f37' onClick={confirmRename}>Copy as this name</Btn>
              </div>
            </div>

            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <Btn onClick={confirmSkip}>Skip (don't copy)</Btn>
              <Btn bg='#b45309' onClick={confirmReplace}>Replace existing</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

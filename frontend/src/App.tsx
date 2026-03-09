import { BrowserRouter, Route, Routes } from 'react-router-dom'
import ProjectList from './pages/ProjectList'
import ProjectView from './pages/ProjectView'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/projects/:projectId" element={<ProjectView />} />
      </Routes>
    </BrowserRouter>
  )
}

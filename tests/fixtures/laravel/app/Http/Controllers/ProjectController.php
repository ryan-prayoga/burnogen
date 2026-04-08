<?php

namespace App\Http\Controllers;

use App\Http\Resources\ProjectResource;
use Illuminate\Http\Request;

class ProjectController extends Controller
{
    public function index()
    {
        $page = request()->query('page');

        return ProjectResource::collection([
            (object) [
                'id' => 1,
                'name' => 'Launchpad',
                'owner_email' => 'owner@example.com',
            ],
            (object) [
                'id' => 2,
                'name' => 'Atlas',
                'owner_email' => 'atlas@example.com',
            ],
        ])->additional([
            'meta' => [
                'current_page' => $page ?? 1,
                'per_page' => 15,
                'total' => 2,
            ],
            'links' => [
                'next' => null,
                'prev' => null,
            ],
        ]);
    }

    public function show(Request $request)
    {
        Project::query()->findOrFail(1);

        return ProjectResource::make((object) [
            'id' => 1,
            'name' => 'Launchpad',
            'owner_email' => 'owner@example.com',
        ])->additional([
            'meta' => [
                'trace_id' => 'trace_123',
            ],
        ]);
    }
}
